import { scheduleMicrotask } from './ReactFiberHostConfig'
import { getCurrentUpdatePriority } from './ReactEventPriorities'
import { createWorkInProgress } from './ReactFiber'
import { beginWork } from './ReactFiberBeginWork'
import {
  commitBeforeMutationEffects,
  commitLayoutEffects,
  commitMutationEffects,
} from './ReactFiberCommitWork'
import { completeWork } from './ReactFiberCompleteWork'
import { MutationMask, NoFlags } from './ReactFiberFlags'
import {
  getHighestPriorityLane,
  getNextLanes,
  includesSomeLane,
  Lane,
  Lanes,
  markRootUpdated,
  markStarvedLanesAsExpired,
  mergeLanes,
  NoLane,
  NoLanes,
  NoTimestamp,
  SyncLane,
} from './ReactFiberLane'
import {
  flushSyncCallbacks,
  scheduleLegacySyncCallback,
} from './ReactFiberSyncTaskQueue'
import { Fiber, FiberRoot } from './ReactInternalTypes'
import { LegacyRoot } from './ReactRootTags'
import { ConcurrentMode, NoMode } from './ReactTypeOfMode'
import { HostRoot } from './ReactWorkTags'
import { now } from './Scheduler'

type ExecutionContext = number
export const NoContext = /*             */ 0b000000
const BatchedContext = /*               */ 0b000001
const LegacyUnbatchedContext = /*       */ 0b000100
const RenderContext = /*                */ 0b001000
const CommitContext = /*                */ 0b010000

let executionContext: ExecutionContext = NoContext

/**
 * 当前在构建应用的root
 */
let workInProgressRoot: FiberRoot | null = null

/**
 * 当前正在进行工作的fiber节点
 */
let workInProgress: Fiber | null = null

/**
 * 当前渲染中的Lanes
 */
let workInProgressRootRenderLanes: Lanes = NoLanes

let currentEventTime: number = NoTimestamp

export let subtreeRenderLanes: Lanes = NoLanes

const completeUnitOfWork = (unitOfWork: Fiber): void => {
  let completedWork: Fiber | null = unitOfWork

  do {
    const current = completedWork.alternate

    const returnFiber: Fiber | null = completedWork.return

    let next = completeWork(current, completedWork)

    // if (next !== null) {
    //   //// Something suspended. Re-render with the fallback children.
    //   workInProgress = next
    //   return
    // }

    const siblingFiber = completedWork.sibling

    //由于是前序遍历，当一个节点的"归阶段"完成后立马进入其下一个兄弟节点的递阶段
    if (siblingFiber !== null) {
      workInProgress = siblingFiber
      return
    }

    //returnFiber的所有子节点都完成递和归阶段，接下来到returnFiber的归阶段了
    completedWork = returnFiber
    workInProgress = completedWork
  } while (completedWork !== null)
}

const performUnitOfWork = (unitOfWork: Fiber): void => {
  const current = unitOfWork.alternate

  let next: Fiber | null = null

  //创建或者reconcile unitOfWork.child并将其返回
  next = beginWork(current, unitOfWork, subtreeRenderLanes)

  //进行的时前序遍历，next为null说明该节点没有子节点了，对其进行归过程
  if (next === null) {
    //todo completeUnitofWork
    completeUnitOfWork(unitOfWork)
  } else {
    //将workInProgress赋值为unitOfWork的第一个子节点
    workInProgress = next
  }
}

/**
 *
 * @param root 新一轮更新的FiberRoot
 */
const prepareFreshStack = (root: FiberRoot, lanes: Lanes) => {
  workInProgressRoot = root
  //创建workInProgress的HostRoot其props为null
  workInProgress = createWorkInProgress(root.current, null)
  workInProgressRootRenderLanes = subtreeRenderLanes = lanes
}

const renderRootSync = (root: FiberRoot, lanes: Lanes) => {
  //如果根节点改变调用prepareFreshStack重置参数

  const prevExecutionContext = executionContext
  executionContext |= RenderContext

  if (workInProgressRoot !== root) {
    prepareFreshStack(root, lanes)
  }

  while (workInProgress !== null) {
    performUnitOfWork(workInProgress)
  }

  executionContext = prevExecutionContext

  /**
   * 把它设置为null表示当前没有进行中的render
   */
  workInProgressRoot = null
  workInProgressRootRenderLanes = NoLanes
}

const commitRootImpl = (root: FiberRoot): null => {
  const finishedWork = root.finishedWork

  if (finishedWork === null) return null

  root.finishedWork = null

  workInProgressRoot = null
  workInProgress = null

  const subtreeHasEffects =
    (finishedWork.subtreeFlags & MutationMask) !== NoFlags
  const rootHasEffect = (finishedWork.flags & MutationMask) !== NoFlags

  if (rootHasEffect || subtreeHasEffects) {
    commitBeforeMutationEffects(root, finishedWork)

    commitMutationEffects(root, finishedWork)

    root.current = finishedWork

    commitLayoutEffects(finishedWork, root)
  } else {
    root.current = finishedWork
  }

  return null
}

const commitRoot = (root: FiberRoot): null => {
  commitRootImpl(root)
  return null
}

/**
 * 这个是不通过Scheduler调度的同步任务的入口
 * @param root
 */
export const performSyncWorkOnRoot = (root: FiberRoot) => {
  const lanes = getNextLanes(root, NoLanes)

  if (!includesSomeLane(lanes, SyncLane)) return null

  const exitStatus = renderRootSync(root, lanes)

  const finishedWork: Fiber | null = root.current.alternate

  root.finishedWork = finishedWork

  commitRoot(root)

  return null
}

const ensureRootIsScheduled = (root: FiberRoot, currentTime: number) => {
  const existingCallbackNode = root.callbackNode

  markStarvedLanesAsExpired(root, currentTime)

  const nextLanes = getNextLanes(
    root,
    root === workInProgressRoot ? workInProgressRootRenderLanes : NoLanes
  )

  if (nextLanes === NoLanes) {
    if (existingCallbackNode !== null) {
      throw new Error('Not Implement')
    }
    root.callbackNode = null
    root.callbackPriority = NoLane
    return
  }

  /**
   * 我们取最高的lane去代表该callback的优先级
   */
  const newCallbackPriority = getHighestPriorityLane(nextLanes)

  const existingCallbackPriority = root.callbackPriority
  /**
   * 检查是是否已经存在任务，如果存在且优先级相同就可以复用他
   */
  if (existingCallbackPriority === newCallbackPriority) {
    return
  }

  if (existingCallbackNode !== null) {
    throw new Error('Not Implement')
  }

  //调度一个新回调
  let newCallbackNode
  if (newCallbackPriority === SyncLane) {
    if (root.tag === LegacyRoot) {
      scheduleLegacySyncCallback(performSyncWorkOnRoot.bind(null, root))
    } else {
      throw new Error('Not Implement')
    }

    scheduleMicrotask(flushSyncCallbacks)
    newCallbackNode = null
  } else {
    throw new Error('Not Implement')
  }
}

const markUpdateLaneFromFiberToRoot = (
  sourceFiber: Fiber,
  lane: Lane
): FiberRoot | null => {
  sourceFiber.lanes = mergeLanes(sourceFiber.lanes, lane)
  let alternate = sourceFiber.alternate

  if (alternate !== null) {
    alternate.lanes = mergeLanes(alternate.lanes, lane)
  }

  let node = sourceFiber
  let parent = sourceFiber.return

  while (parent !== null) {
    parent.childLanes = mergeLanes(parent.childLanes, lane)
    alternate = parent.alternate

    if (alternate !== null) {
      alternate.childLanes = mergeLanes(alternate.childLanes, lane)
    }

    node = parent
    parent = node.return
  }

  if (node.tag === HostRoot) {
    const root: FiberRoot = node.stateNode
    return root
  } else {
    return null
  }
}

export const requestEventTime = () => {
  if ((executionContext & (RenderContext | CommitContext)) !== NoContext) {
    return now()
  }

  if (currentEventTime !== NoTimestamp) {
    return currentEventTime
  }

  currentEventTime = now()
  return currentEventTime
}

/**
 * 调度fiber节点上的更新
 *
 * @param fiber 当前产生更新的fiber节点
 * @returns 产生更新fiber树的FiberRoot(注意不是rootFiber)
 */
export const scheduleUpdateOnFiber = (
  fiber: Fiber,
  lane: Lane,
  eventTime: number
): FiberRoot | null => {
  const root = markUpdateLaneFromFiberToRoot(fiber, lane)

  if (root === null) {
    return null
  }

  markRootUpdated(root, lane, eventTime)

  if (root === workInProgressRoot) {
    throw new Error('Not Implement')
  }

  if (lane === SyncLane) {
    if (
      //检查是是否该调用是否处于unbatchedUpdates中
      (executionContext & LegacyUnbatchedContext) !== NoContext &&
      //检查是否以及处于渲染中
      (executionContext & (RenderContext | CommitContext)) === NoContext
    ) {
      // 这个是一个遗留模式的情况，
      //首次调用ReactDOM.render时处于batchedUpdates中的逻辑因该是同步执行的
      //但是layout updates应该推迟到改batch的结尾
      performSyncWorkOnRoot(root)
    } else {
      ensureRootIsScheduled(root, eventTime)
      // throw new Error('Not Implement')
    }
  } else {
    throw new Error('Not Implement')
  }

  return root
}

export const discreteUpdates = <A, B, C, D, R>(
  fn: (a: A, b: B, c: C, d: D) => R,
  a: A,
  b: B,
  c: C,
  d: D
): R => {
  return fn(a, b, c, d)
}

/**
 * 将要执行的函数放入BatchedContext上下文下，此后在函数内创建的所有的更新指挥出发一次reconcil
 * @param fn 要执行的函数
 * @param a
 * @returns
 */
export const batchedEventUpdates = <A, R>(fn: (a: A) => R, a: A): R => {
  const prevExecutionContext = executionContext
  executionContext |= BatchedContext
  try {
    return fn(a)
  } finally {
    executionContext = prevExecutionContext
  }
}

/**
 * 给执行上下文加上LegacyUnbatchedContext,等到scheduleUpdateOnFilber执行时
 * 就会跳转到performSyncWorkOnRoot逻辑
 * @param fn 要在该上下文中执行的操作要执行的操作
 * @param a
 * @returns
 */
export const unbatchedUpdates = <A, R>(fn: (a: A) => R, a: A): R => {
  const prevExecutionContext = executionContext
  executionContext &= ~BatchedContext
  executionContext |= LegacyUnbatchedContext

  try {
    return fn(a)
  } finally {
    executionContext = prevExecutionContext
  }
}

export const requestUpdateLane = (fiber: Fiber): Lane => {
  const mode = fiber.mode

  if ((mode & ConcurrentMode) === NoMode) return SyncLane
  else if ((executionContext & RenderContext) !== NoContext) {
    throw new Error('Not Implement')
  }

  throw new Error('Not Implement')
  // const updateLane: Lane = getCurrentUpdatePriority()

  // if (updateLane !== NoLane) {
  //   return updateLane
  // }

  // const eventLane: Lane = getCurrentEventPriority()

  // return eventLane
}