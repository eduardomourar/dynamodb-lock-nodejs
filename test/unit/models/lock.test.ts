import {Lock, LockOptions} from "../../../src/model/lock";
import {LockOptionsValidationError} from "../../../src/model/errors";
import {v4} from "uuid";

describe("LockItem", () => {
    const lockId = "lockId";
    const lockGroup = "lockGroup";
    const ownerName = v4();
    const recordVersionNumber = v4();

    it("should throw error if prolongLease enabled and prolongEveryMs is equal or longer than leaseDurationInMs/2", () => {
        expect(() => {
            Lock.create(lockGroup, lockId, ownerName, undefined, undefined, false, {
                leaseDurationInMs: 10_000,
                prolongEveryMs: 5_000
            });
        }).toThrowError(LockOptionsValidationError);
    });

    it("should initialize and validate lock properly", () => {
        const lockItem = Lock.create(lockGroup, lockId, ownerName);
        expect(lockItem.lockId).toBe(lockId);
        expect(lockItem.lockGroup).toBe(lockGroup);
        expect(lockItem.ownerName).toBe(ownerName);
    });

    it("should initialize and validate lock properly with optional properties", () => {
        const lockOptions: LockOptions = {
            leaseDurationInMs: 40_000,
            prolongEveryMs: 12_000,
            prolongLeaseEnabled: true,
            waitDurationInMs: 1_000,
            trustLocalTime: false,
            additionalAttributes: {someData: "check"},
            maxRetryCount: 10
        };
        const lastUpdatedTimeInMs = Date.now();
        const lockItem = Lock.create(
            lockGroup,
            lockId,
            ownerName,
            recordVersionNumber,
            lastUpdatedTimeInMs,
            true,
            lockOptions
        );
        expect(lockItem.lockId).toBe(lockId);
        expect(lockItem.lockGroup).toBe(lockGroup);
        expect(lockItem.ownerName).toBe(ownerName);
        expect(lockItem.recordVersionNumber).toBe(recordVersionNumber);
        expect(lockItem.lastUpdatedTimeInMs).toBe(lastUpdatedTimeInMs);
        expect(lockItem.prolongEveryMs).toBe(lockOptions.prolongEveryMs);
        expect(lockItem.prolongLeaseEnabled).toBe(lockOptions.prolongLeaseEnabled);
        expect(lockItem.waitDurationInMs).toBe(lockOptions.waitDurationInMs);
        expect(lockItem.trustLocalTime).toBe(lockOptions.trustLocalTime);
        expect(lockItem.maxRetryCount).toBe(lockOptions.maxRetryCount);
        expect(lockItem.leaseDurationInMs).toBe(lockOptions.leaseDurationInMs);
        expect(lockItem.additionalAttributes).toBe(lockOptions.additionalAttributes);
    });

    it("getUniqueLockIdentifier should return correct identifier", () => {
        const lockItem = Lock.create(lockGroup, lockId, ownerName);
        expect(lockItem.getUniqueLockIdentifier()).toBe(`${lockGroup}|${lockId}`);
    });

    it("acquired should set isAcquired", () => {
        const lockItem = Lock.create(lockGroup, lockId, ownerName);
        lockItem.acquired();

        expect(lockItem.isAcquired).toBe(true);
    });

    it("prolonged should set newRecordVersionNumber and lastUpdatedTimeInMs", () => {
        const lockItem = Lock.create(lockGroup, lockId, ownerName);
        const rvn = "someRecordVersionNumber";
        const now = new Date();

        lockItem.prolonged(rvn, now);

        expect(lockItem.recordVersionNumber).toBe(rvn);
        expect(lockItem.lastUpdatedTimeInMs).toBe(now.getTime());
    });

    it("released should set isAcquired false", () => {
        const lockItem = Lock.create(lockGroup, lockId, ownerName);
        lockItem.prolonged("someRecordVersionNumber", new Date());

        expect(lockItem.isAcquired).toBe(false);
    });

    it("released should clearTimeout if exists", () => {
        const lockItem = Lock.create(lockGroup, lockId, ownerName);
        const clearTimeoutFn = jest.fn();
        const timeoutHandler = 1;
        jest.spyOn(global, "clearTimeout").mockImplementation(clearTimeoutFn);
        lockItem.attemptProlonging(timeoutHandler as unknown as NodeJS.Timeout);
        lockItem.prolonged("someRecordVersionNumber", new Date());

        lockItem.released();

        expect(clearTimeoutFn).toBeCalledWith(timeoutHandler);
    });

    it("attemptLocking should set newRecordVersionNumber and lastUpdatedTimeInMs", () => {
        const rvn = "someRecordVersionNumber";
        const now = new Date();
        const lockItem = Lock.create(lockGroup, lockId, ownerName);
        lockItem.attemptLocking(rvn, now);

        expect(lockItem.recordVersionNumber).toBe(rvn);
        expect(lockItem.lastUpdatedTimeInMs).toBe(now.getTime());
    });

    it("resetLockingAttempt should set recordVersionNumber and lastUpdatedTimeInMs to undefined", () => {
        const rvn = "someRecordVersionNumber";
        const now = new Date();
        const lockItem = Lock.create(lockGroup, lockId, ownerName);
        lockItem.attemptLocking(rvn, now);
        lockItem.resetLockingAttempt();

        expect(lockItem.recordVersionNumber).toBeUndefined();
        expect(lockItem.lastUpdatedTimeInMs).toBeUndefined();
    });
});
