import {Lock, LockOptions} from "./model/lock";
import {v4} from "uuid";
import {ATTRS, DataLayer} from "./data-layer";
import {LockNotGrantedError} from "./model/errors";
import {AWSError} from "aws-sdk";

export type LogSeverity = "error" | "warn" | "info";
export type LogCallbackType = (severity: LogSeverity, message: string) => void;

export class LockClient {
    readonly ownerName: string;
    private acquiredLocks: {[key: string]: Lock} = {};

    constructor(public readonly dataLayer: DataLayer, public readonly logCallback?: LogCallbackType) {
        this.logCallback = logCallback;
        this.ownerName = LockClient.generateUUID();
    }

    /**
     * @throws LockOptionsValidationError
     * @throws LockNotGrantedError
     * @throws AWS.Error
     */
    async lock(lockGroup: string, lockId: string, lockOptions: LockOptions = {}): Promise<Lock> {
        const lock = Lock.create(lockGroup, lockId, this.ownerName, undefined, undefined, false, lockOptions);
        this.log("info", `Trying to acquire lock for: ${lock.getUniqueLockIdentifier()}`);
        await this.acquireLock(lock);
        return lock;
    }

    /**
     * @throws AWS.Error
     */
    async releaseLock(lock: Lock): Promise<void> {
        // Remove the lock ASAP from the local list and call released to stop next timeout.
        // Whether the operation successful is not important
        lock.released();
        delete this.acquiredLocks[lock.getUniqueLockIdentifier()];

        try {
            await this.dataLayer.deleteLock(lock);
            this.log("info", `Lock: ${lock.getUniqueLockIdentifier()} is released.`);
        } catch (error) {
            if ((error as AWSError).code === "ConditionalCheckFailedException") {
                // Lock is already released by others or owner changed.
                // This should never happen, no user wants it, it means that configs, or the logic of the app is flaw.
                this.log(
                    "warn",
                    `Tried to remove the lock but it is already released: ${lock.getUniqueLockIdentifier()}`
                );
                return;
            }
            // Unknown error, throw
            throw error;
        }
    }

    /**
     * @throws AWS.Error
     */
    async releaseAllLocks(): Promise<void> {
        // Remove all acquiredLocks ASAP to stop prolonging lease.
        // Whether the operation successful is not important
        const toBeRemovedLocks = {...this.acquiredLocks};
        this.acquiredLocks = {};

        const releaseLockPromises = [];
        for (const lock of Object.values(toBeRemovedLocks)) {
            lock.released();
            releaseLockPromises.push(lock);
        }

        await Promise.all(releaseLockPromises);
    }

    private async acquireLock(lock: Lock, retryCount = 0): Promise<Lock> {
        const {lockGroup, lockId} = lock;
        if (lock.isAcquired) {
            throw new LockNotGrantedError(`Lock is already acquired: ${lock.getUniqueLockIdentifier()}`);
        }

        if (lock.maxRetryCount !== undefined && retryCount > lock.maxRetryCount) {
            throw new LockNotGrantedError(
                `${lock.getUniqueLockIdentifier()} could not be acquired after retrying for ${
                    lock.maxRetryCount
                } times.`
            );
        }
        retryCount++;

        const existingLockAttrs = await this.dataLayer.getLockByGroupAndId(lockGroup, lockId);
        if (existingLockAttrs) {
            const existingLock = Lock.create(
                lockGroup,
                lockId,
                existingLockAttrs[ATTRS.ownerName],
                existingLockAttrs[ATTRS.recordVersionNumber],
                existingLockAttrs[ATTRS.lastUpdatedTimeInMs],
                true,
                {
                    additionalAttributes: existingLockAttrs[ATTRS.additionalAttributes],
                    leaseDurationInMs: existingLockAttrs[ATTRS.leaseDurationInMs]
                }
            );
            this.log("info", `${lock.getUniqueLockIdentifier()} is already exist`);
            // If we can trust local time, we dont need to wait for a leaseDuration (waitDuration)
            // If existing lock already stop prolonging/renewing its lease, we can immediately try to acquire the lock
            if (lock.trustLocalTime && existingLock.leaseExpirationTimePassed()) {
                this.log(
                    "info",
                    `trustLocalTime enabled, not waiting to acquire already expired lock: ${existingLock.getUniqueLockIdentifier()}`
                );
                await this.stealExistingLock(lock, existingLock, retryCount);
            } else {
                await this.tryStealingExistingLock(lock, existingLock, retryCount);
            }
        } else {
            this.log("info", `${lock.getUniqueLockIdentifier()} is not exist, trying to acquire a new lock`);
            await this.acquireNewLock(lock, retryCount);
        }

        return lock;
    }

    private async acquireNewLock(lock: Lock, retryCount: number): Promise<void> {
        retryCount++;
        try {
            lock.attemptLocking(LockClient.generateUUID(), new Date());
            await this.dataLayer.createNewLock(lock);
            this.lockAcquired(lock);
        } catch (error) {
            if ((error as AWSError).code === "ConditionalCheckFailedException") {
                this.log("info", `Trying to acquire new lock but ${lock.getUniqueLockIdentifier()} is already exist`);
                // There is already existing lock with given lockGroup|lockId,
                // reset changes and start over.
                lock.resetLockingAttempt();
                await this.acquireLock(lock, retryCount);
            } else {
                // Unknown error, throw and stop locking.
                throw error;
            }
        }
    }

    private async tryStealingExistingLock(newLock: Lock, existingLock: Lock, retryCount: number): Promise<void> {
        if (newLock.trustLocalTime) {
            const waitDuration = newLock.waitDurationInMs ?? 0;
            await LockClient.waitMs(waitDuration);
            this.log(
                "info",
                `trustLocalTime enabled, waiting for ${waitDuration}ms to check again not expired lock: ${newLock.getUniqueLockIdentifier()}`
            );
            await this.acquireLock(newLock, retryCount);
        } else {
            this.log(
                "info",
                `Waiting for a lease duration make sure existing lock does not renewed: ${newLock.getUniqueLockIdentifier()}`
            );
            await LockClient.waitMs(existingLock.leaseDurationInMs);
            await this.stealExistingLock(newLock, existingLock, retryCount);
        }
    }

    private async stealExistingLock(newLock: Lock, existingLock: Lock, retryCount: number): Promise<void> {
        try {
            newLock.attemptLocking(LockClient.generateUUID(), new Date());
            await this.dataLayer.updateLockWithNewLockContent(existingLock, newLock);
            this.lockAcquired(newLock);
            this.log(
                "info",
                `Existing ${newLock.getUniqueLockIdentifier()} successfully replaced (stolen) with the requested lock`
            );
        } catch (error) {
            if ((error as AWSError).code === "ConditionalCheckFailedException") {
                // existingLock has now different recordVersionNumber which means
                // still locked (lease prolonged/renewed), reset changes and start over.
                this.log("info", `Trying to acquire ${newLock.getUniqueLockIdentifier()} but its lease renewed`);
                newLock.resetLockingAttempt();
                await this.acquireLock(newLock, retryCount);
            } else {
                // Unknown error, throw and stop locking.
                throw error;
            }
        }
    }

    private lockAcquired(lock: Lock) {
        this.log("info", `Lock: ${lock.getUniqueLockIdentifier()} is acquired`);
        lock.acquired();
        this.acquiredLocks[lock.getUniqueLockIdentifier()] = lock;
        if (lock.prolongLeaseEnabled) {
            this.log("info", `Starting prolongLease for the lock ${lock.getUniqueLockIdentifier()}`);
            this.startProlongingLease(lock.getUniqueLockIdentifier(), lock.prolongEveryMs);
        }
    }

    private startProlongingLease(lockIdentifier: string, prolongEveryMs: number) {
        const lock = this.acquiredLocks[lockIdentifier];
        const timeoutHandler = setTimeout(async () => {
            if (!lock || !lock.isAcquired) {
                // Lock is already released, stopping prolong lease.
                return;
            }
            await this.prolongLease(lock);
            this.startProlongingLease(lockIdentifier, prolongEveryMs);
        }, prolongEveryMs);

        lock?.attemptProlonging(timeoutHandler);
    }

    private async prolongLease(lock: Lock): Promise<void> {
        const newRecordVersionNumber = LockClient.generateUUID();
        const now = new Date();
        await this.dataLayer.updateRecordVersionNumberAndTime(lock, newRecordVersionNumber, now);
        lock.prolonged(newRecordVersionNumber, now);
        this.log("info", `Lease prolonged/renewed for: ${lock.getUniqueLockIdentifier()}`);
    }

    private log(severity: LogSeverity, message: string): void {
        this.logCallback && this.logCallback(severity, message);
    }

    static waitMs(ms: number): Promise<void> {
        return new Promise((resolve) => {
            setTimeout(resolve, ms);
        });
    }

    static generateUUID(): string {
        return v4();
    }
}
