import {dynamoDBLockClientFactory, LockClient} from "../../index";
import {createLockTable, destroyLockTable, createDocumentClient} from "./helper/dynamodb-helper";
import {LockNotGrantedError} from "../../src/model/errors";

jest.setTimeout(60_000);

describe("DynamoDBLockClient", () => {
    const lockId = "123";
    const lockGroup = "abc";
    const documentClient = createDocumentClient();
    let lockClient: LockClient;

    beforeEach(async () => {
        await createLockTable();
    });

    afterEach(async () => {
        await lockClient.releaseAllLocks();
        await destroyLockTable();
    });

    it("should create lock immediately if there is no existing lock", async () => {
        lockClient = dynamoDBLockClientFactory(documentClient);
        const startTime = Date.now();
        const lock = await lockClient.lock(lockGroup, lockId);
        const lockAcquiredTime = Date.now();
        // 400 ms as a buffer for other operations
        expect(lockAcquiredTime - startTime).toBeLessThan(400);
        expect(lock.isAcquired).toBeTruthy();
    });

    it("should throw error if maxRetryCount reached while trying to acquire new lock", async () => {
        lockClient = dynamoDBLockClientFactory(documentClient);
        await lockClient.lock(lockGroup, lockId, {
            leaseDurationInMs: 1_000,
            prolongEveryMs: 250
        });

        await expect(
            lockClient.lock(lockGroup, lockId, {
                maxRetryCount: 10,
                trustLocalTime: true,
                waitDurationInMs: 0
            })
        ).rejects.toThrowError(LockNotGrantedError);
    });

    it("should acquire a lock without explicitly releasing if existing lock is already expired", async () => {
        lockClient = dynamoDBLockClientFactory(documentClient);
        const promises = [];
        for (let i = 0; i < 50; i++) {
            promises.push(
                lockClient.lock(lockGroup, lockId, {
                    leaseDurationInMs: 500,
                    prolongLeaseEnabled: false
                })
            );
        }

        await Promise.all(promises);
    });

    it("should acquire two lock with same id but different group", async () => {
        const now = Date.now();
        lockClient = dynamoDBLockClientFactory(documentClient);
        const lock1 = await lockClient.lock("group1", lockId);
        const lock2 = await lockClient.lock("group2", lockId);
        const locksAcquired = Date.now();
        // 400 ms as a buffer for other operations
        expect(locksAcquired - now).toBeLessThan(400);
        expect(lock1.isAcquired).toBeTruthy();
        expect(lock2.isAcquired).toBeTruthy();
    });

    it("should immediately acquire the existing lock if trustLocalTime is true and the existing lock is already expired", async () => {
        lockClient = dynamoDBLockClientFactory(documentClient);
        await lockClient.lock(lockGroup, lockId, {
            leaseDurationInMs: 1_000,
            prolongLeaseEnabled: false
        });
        await LockClient.waitMs(2_000); // Lock expired

        const startTime = Date.now();
        const lock = await lockClient.lock(lockGroup, lockId, {
            trustLocalTime: true,
            waitDurationInMs: 0
        });
        const lockAcquiredTime = Date.now();
        // 400 ms as a buffer for other operations
        expect(lockAcquiredTime - startTime).toBeLessThan(400);
        expect(lock.isAcquired).toBeTruthy();
    });

    it("should call log function when log callback is provided", async () => {
        const logCallbackMock = jest.fn();
        lockClient = dynamoDBLockClientFactory(documentClient, undefined, logCallbackMock);
        await lockClient.lock(lockGroup, lockId);
        expect(logCallbackMock.mock.calls.length).toBeGreaterThan(2);
    });

    it("should throw error when invalid lockTableConfig provided", async () => {
        lockClient = dynamoDBLockClientFactory(documentClient, {
            tableName: "NotExistTable"
        });
        await expect(lockClient.lock(lockGroup, lockId)).rejects.toThrowError(
            "Cannot do operations on a non-existent table"
        );
    });
});
