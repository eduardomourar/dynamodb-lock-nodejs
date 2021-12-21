import {LockOptionsValidationError} from "./errors";

/**
 * @typedef LockOptions
 * @type {object}
 * @property {number} [leaseDurationInMs=20_000] - Lock acquired for the specified time, if prolongLease enabled,
 *     this is the minimum lock duration.
 * @property {boolean} [prolongLeaseEnabled=true] - Keep delaying locks expire until it is released by the acquirer.
 * @property {number} [prolongEveryMs=5_000] -  Acquired lock lease prolonged by this duration if prolongLeaseEnabled
 *     is set to true. It should not be longer than leaseDurationInMs/2, recommendation is leaseDurationInMs/4,
 * @property {boolean} [trustLocalTime=false] - If requested lock is already acquired and valid, either wait for
 *     waitDurationInMs to check the lock again or check stored time value and determined if the leaseDuration
 *     is already passed.
 *     It improves performance (you are not waiting for leaseDurationInMs to re-acquire expired lock) but the
 *     clock skew can happen which means different systems do not share the same time.
 * @property {number} [waitDurationInMs] - If a requested lock is already exist, wait for waitDurationInMs to
 *     check again If not set, waitDurationInMs is equal to existing lock's leaseDurationInMs
 * @property {number} [maxRetryCount] - Max retry count, if a lock is already acquired and valid, it will try to
 *     acquire it at most this times
 * @property {object} [additionalAttributes={}] - Additional attrs can be stored alongside with the lock in dynamodb.
 */
export type LockOptions = {
    readonly leaseDurationInMs?: number;
    readonly prolongLeaseEnabled?: boolean;
    readonly prolongEveryMs?: number;
    readonly trustLocalTime?: boolean;
    readonly waitDurationInMs?: number;
    readonly maxRetryCount?: number;
    readonly additionalAttributes?: {[key: string]: unknown};
};

export class Lock {
    /**
     * @param {string} lockGroup - lockGroup is the sortKey of lockTable
     * @param {string} lockId - lockId is the partitionKey of lockTable
     * @param {string} ownerName - ownerName used to make sure only the owner lock can change its state.
     * @param {string} [recordVersionNumber] - If the acquired lock still has the same recordVersionNumber after the lease duration time has passed,
     *     another lock request with same id and group will determine that the lock is stale and expire it.
     * @param {number} [lastUpdatedTimeInMs] - lastUpdatedTime set when the locks acquired or lease prolonged.
     * @param {boolean} isAcquired - whether lock is already acquired or not
     * @param {LockOptions} lockOptions
     */
    static create(
        lockGroup: string,
        lockId: string,
        ownerName: string,
        recordVersionNumber?: string,
        lastUpdatedTimeInMs?: number,
        isAcquired = false,
        lockOptions: LockOptions = {}
    ): Lock {
        const lock = new Lock(
            lockId,
            lockGroup,
            ownerName,
            recordVersionNumber,
            lastUpdatedTimeInMs,
            isAcquired,
            lockOptions.leaseDurationInMs,
            lockOptions.additionalAttributes,
            lockOptions.prolongLeaseEnabled,
            lockOptions.prolongEveryMs,
            lockOptions.maxRetryCount,
            lockOptions.trustLocalTime,
            lockOptions.waitDurationInMs
        );

        Lock.validate(lock);
        return lock;
    }

    static validate(lockItem: Lock): void {
        if (
            !lockItem.isAcquired &&
            lockItem.prolongLeaseEnabled &&
            lockItem.prolongEveryMs >= lockItem.leaseDurationInMs / 2
        ) {
            throw new LockOptionsValidationError(
                `prolongEveryMs(${lockItem.prolongEveryMs}) can not be longer than leaseDurationInMs/2(${lockItem.leaseDurationInMs})`
            );
        }
    }

    private timeoutHandler: NodeJS.Timeout | undefined;

    private constructor(
        readonly lockId: string,
        readonly lockGroup: string,
        readonly ownerName: string,
        public recordVersionNumber?: string,
        public lastUpdatedTimeInMs?: number,
        public isAcquired = false,
        readonly leaseDurationInMs: number = 20_000,
        readonly additionalAttributes: {[key: string]: unknown} = {},
        readonly prolongLeaseEnabled = true,
        readonly prolongEveryMs = 5_000,
        readonly maxRetryCount?: number,
        readonly trustLocalTime = false,
        readonly waitDurationInMs?: number
    ) {}

    getUniqueLockIdentifier(): string {
        return `${this.lockGroup}|${this.lockId}`;
    }

    leaseExpirationTimePassed(): boolean {
        if (!this.lastUpdatedTimeInMs) {
            return false;
        }

        const now = Date.now();
        const leaseExpirationTime = this.lastUpdatedTimeInMs + this.leaseDurationInMs;
        return now > leaseExpirationTime;
    }

    acquired(): void {
        this.isAcquired = true;
    }

    released(): void {
        this.isAcquired = false;
        if (this.timeoutHandler) {
            clearTimeout(this.timeoutHandler);
            this.timeoutHandler = undefined;
        }
    }

    attemptLocking(recordVersionNumber: string, when: Date): void {
        this.recordVersionNumber = recordVersionNumber;
        this.lastUpdatedTimeInMs = when.getTime();
    }

    resetLockingAttempt(): void {
        this.lastUpdatedTimeInMs = undefined;
        this.recordVersionNumber = undefined;
    }

    attemptProlonging(timeoutHandler: NodeJS.Timeout) {
        this.timeoutHandler = timeoutHandler;
    }

    prolonged(newRecordVersionNumber: string, when: Date): void {
        this.recordVersionNumber = newRecordVersionNumber;
        this.lastUpdatedTimeInMs = when.getTime();
    }
}
