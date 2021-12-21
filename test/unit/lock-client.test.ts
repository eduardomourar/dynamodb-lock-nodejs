import {LockClient} from "../../src/lock-client";
import {DataLayer} from "../../src/data-layer";
import {v4} from "uuid";
import {LockNotGrantedError} from "../../src/model/errors";
import {Lock} from "../../src/model/lock";

describe("LockClient", () => {
    const getLockByGroupAndIdMockFn = jest.fn();
    const createNewLockMockFn = jest.fn();
    const updateLockWithNewLockContentFn = jest.fn();
    const updateRecordVersionNumberAndTimeFn = jest.fn();
    const deleteLockFn = jest.fn();
    let lockClient: LockClient;

    const dataLayerMock = {
        getLockByGroupAndId: getLockByGroupAndIdMockFn,
        createNewLock: createNewLockMockFn,
        updateRecordVersionNumberAndTime: updateRecordVersionNumberAndTimeFn,
        updateLockWithNewLockContent: updateLockWithNewLockContentFn,
        deleteLock: deleteLockFn
    } as unknown as DataLayer;

    const lockId = "id";
    const lockGroup = "group";

    afterEach(async () => {
        await lockClient.releaseAllLocks();
        jest.useRealTimers();
        jest.clearAllMocks();
    });

    it("should acquire lock immediately if there is none exists with same id", async () => {
        lockClient = new LockClient(dataLayerMock);
        getLockByGroupAndIdMockFn.mockResolvedValueOnce(undefined);
        createNewLockMockFn.mockResolvedValueOnce(undefined);

        const lock = await lockClient.lock(lockGroup, lockId, {
            prolongLeaseEnabled: false
        });

        expect(lock).toBeDefined();
        expect(lock.lockId).toBe(lockId);
        expect(lock.lockGroup).toBe(lockGroup);
    });

    it("should acquire lock immediately and start prolonging if there is no lock exists with same id", async () => {
        jest.useFakeTimers();
        lockClient = new LockClient(dataLayerMock);
        getLockByGroupAndIdMockFn.mockResolvedValueOnce(undefined);
        createNewLockMockFn.mockResolvedValueOnce(undefined);

        await lockClient.lock(lockGroup, lockId, {
            prolongEveryMs: 200
        });

        jest.runOnlyPendingTimers();
        const prolongLeaseLockParam = updateRecordVersionNumberAndTimeFn.mock.calls[0][0];
        expect(prolongLeaseLockParam).toBeDefined();
        expect(prolongLeaseLockParam.lockId).toBe(lockId);
        expect(prolongLeaseLockParam.lockGroup).toBe(lockGroup);
    });

    it("should throw LockNotGrantedError if the lock is already acquired by the same process and not released", async () => {
        const lock = Lock.create("lockGroup", "lockId", "ownerName");
        lock.acquired();
        jest.spyOn(Lock, "create").mockReturnValueOnce(lock);
        lockClient = new LockClient(dataLayerMock);
        await expect(lockClient.lock(lockGroup, lockId)).rejects.toThrowError(LockNotGrantedError);
    });

    it("should throw error if maxRetryCount reached while trying to acquire new lock", async () => {
        const maxRetryCount = 3;
        lockClient = new LockClient(dataLayerMock);
        getLockByGroupAndIdMockFn.mockResolvedValue({
            ownerName: v4(),
            recordVersionNumber: v4(),
            leaseDurationInMs: 15_000
        });
        updateLockWithNewLockContentFn.mockRejectedValue({
            code: "ConditionalCheckFailedException"
        });

        await expect(
            lockClient.lock(lockGroup, lockId, {
                maxRetryCount,
                trustLocalTime: true,
                prolongLeaseEnabled: false,
                waitDurationInMs: 0
            })
        ).rejects.toThrowError(LockNotGrantedError);
    });

    it("should acquire lock after a leaseDuration if existing lock has not updated.", async () => {
        const now = Date.now();
        const existingLeaseDuration = 1_000;
        lockClient = new LockClient(dataLayerMock);
        getLockByGroupAndIdMockFn.mockResolvedValueOnce({
            ownerName: v4(),
            recordVersionNumber: v4(),
            lastUpdatedTimeInMs: now - existingLeaseDuration - 1_000,
            leaseDurationInMs: existingLeaseDuration
        });
        updateLockWithNewLockContentFn.mockResolvedValueOnce(undefined);

        const lock = await lockClient.lock(lockGroup, lockId, {
            prolongLeaseEnabled: false
        });

        expect(lock).toBeDefined();
        expect(lock.lockId).toBe(lockId);
        expect(lock.lockGroup).toBe(lockGroup);
        // Operation completed after one leaseDuration (~200ms margin for other operations)
        expect(Date.now()).toBeLessThan(now + existingLeaseDuration + 200);
    });

    it("should acquire lock immediately if trustLocalTime enabled without waiting if existing lock has not updated.", async () => {
        const now = Date.now();
        const existingLeaseDuration = 15_000;
        lockClient = new LockClient(dataLayerMock);
        getLockByGroupAndIdMockFn.mockResolvedValueOnce({
            ownerName: v4(),
            recordVersionNumber: v4(),
            lastUpdatedTimeInMs: now - existingLeaseDuration - 1_000,
            leaseDurationInMs: existingLeaseDuration
        });
        updateLockWithNewLockContentFn.mockResolvedValueOnce(undefined);

        const lock = await lockClient.lock(lockGroup, lockId, {
            trustLocalTime: true,
            waitDurationInMs: 200,
            prolongLeaseEnabled: false
        });

        expect(lock).toBeDefined();
        expect(lock.lockId).toBe(lockId);
        expect(lock.lockGroup).toBe(lockGroup);
        // Operation completed immediately (~200ms margin for other operations)
        expect(Date.now()).toBeLessThan(now + 200);
    });

    it("should release the acquired lock immediately", async () => {
        jest.useFakeTimers();
        lockClient = new LockClient(dataLayerMock);
        getLockByGroupAndIdMockFn.mockResolvedValueOnce(undefined);
        createNewLockMockFn.mockResolvedValueOnce(undefined);
        deleteLockFn.mockResolvedValueOnce(undefined);
        const lock = await lockClient.lock(lockGroup, lockId);

        await lockClient.releaseLock(lock);
        jest.runOnlyPendingTimers();

        expect(lock.isAcquired).toBeFalsy();
        const deleteLockParams = deleteLockFn.mock.calls[0][0];
        expect(deleteLockParams).toBeDefined();
        expect(deleteLockParams.lockId).toBe(lockId);
        expect(deleteLockParams.lockGroup).toBe(lockGroup);
    });

    it("should not throw error while releasing the already released lock", async () => {
        jest.useFakeTimers();
        const logCallback = jest.fn();
        lockClient = new LockClient(dataLayerMock, logCallback);
        getLockByGroupAndIdMockFn.mockResolvedValueOnce(undefined);
        createNewLockMockFn.mockResolvedValueOnce(undefined);
        deleteLockFn.mockRejectedValueOnce({
            code: "ConditionalCheckFailedException"
        });

        const lock = await lockClient.lock(lockGroup, lockId);
        jest.runOnlyPendingTimers();

        await lockClient.releaseLock(lock);
        expect(lock.isAcquired).toBeFalsy();
        const logWarnCalls = logCallback.mock.calls.filter((args) => args[0] === "warn");
        expect(logWarnCalls.length).toBe(1);
    });

    it("should throw error while releasing the lock if there is a different error", async () => {
        jest.useFakeTimers();
        const someError = new Error();
        lockClient = new LockClient(dataLayerMock);
        getLockByGroupAndIdMockFn.mockResolvedValueOnce(undefined);
        createNewLockMockFn.mockResolvedValueOnce(undefined);
        deleteLockFn.mockRejectedValueOnce(someError);

        const lock = await lockClient.lock(lockGroup, lockId);
        jest.runOnlyPendingTimers();

        await expect(lockClient.releaseLock(lock)).rejects.toThrowError(someError);
        expect(lock.isAcquired).toBeFalsy();
    });

    it("should release all the locks", async () => {
        jest.useFakeTimers();
        lockClient = new LockClient(dataLayerMock);
        getLockByGroupAndIdMockFn.mockResolvedValue(undefined);
        createNewLockMockFn.mockResolvedValue(undefined);
        deleteLockFn.mockResolvedValue(undefined);

        const lock1 = await lockClient.lock(lockGroup, lockId);
        const lock2 = await lockClient.lock("group2", "id2");
        jest.runOnlyPendingTimers();

        await lockClient.releaseAllLocks();

        expect(lock1.isAcquired).toBeFalsy();
        expect(lock2.isAcquired).toBeFalsy();
    });
});
