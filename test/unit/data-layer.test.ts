import {DocumentClient, promiseResponse} from "./__mocks__/aws-sdk";
import {LockTableConfig} from "../../src/model/lock-table-config";
import {DataLayer} from "../../src/data-layer";
import {DynamoDB} from "aws-sdk";
import {v4} from "uuid";
import {Lock} from "../../src/model/lock";

describe("DataLayer", () => {
    const lockTableConfig = LockTableConfig.create({
        tableName: "lockTable",
        partitionKey: "lockIdField",
        sortKey: "lockGroupField"
    });
    const lockId = "lockId";
    const lockGroup = "lockGroup";
    const ownerName = v4();

    const documentClientMock = new DocumentClient();
    const documentClient = documentClientMock as unknown as DynamoDB.DocumentClient;

    afterEach(() => {
        jest.clearAllMocks();
    });

    it("getLockByGroupAndId should use tableName, partitionKey and sortKey from config", async () => {
        const dataLayer = new DataLayer(documentClient, lockTableConfig);
        const params = {
            TableName: lockTableConfig.tableName,
            Key: {
                [lockTableConfig.partitionKey]: lockId,
                [lockTableConfig.sortKey]: lockGroup
            },
            ConsistentRead: true
        };

        const itemAttrs = await dataLayer.getLockByGroupAndId(lockGroup, lockId);
        expect(documentClientMock.get.mock.calls[0][0]).toStrictEqual(params);
        expect(itemAttrs).toBeUndefined();
    });

    it("getLockByGroupAndId should return undefined if there is no lock", async () => {
        const dataLayer = new DataLayer(documentClient, lockTableConfig);
        const itemAttrs = await dataLayer.getLockByGroupAndId(lockGroup, lockId);
        expect(itemAttrs).toBeUndefined();
    });

    it("getLockByGroupAndId should return LockAttrs if there is a lock", async () => {
        const dataLayer = new DataLayer(documentClient, lockTableConfig);
        const leaseDurationInMs = 1_000;
        promiseResponse.mockReturnValueOnce(
            Promise.resolve({
                Item: {
                    [lockTableConfig.partitionKey]: lockId,
                    [lockTableConfig.sortKey]: lockGroup,
                    ownerName,
                    leaseDurationInMs
                }
            })
        );

        const itemAttrs = await dataLayer.getLockByGroupAndId(lockGroup, lockId);
        expect(itemAttrs).toBeDefined();
        expect(itemAttrs?.ownerName).toBe(ownerName);
        expect(itemAttrs?.leaseDurationInMs).toBe(leaseDurationInMs);
    });

    it("createLock should create a new lock with correct params", async () => {
        const dataLayer = new DataLayer(documentClient, lockTableConfig);
        const lockItem = Lock.create(lockGroup, lockId, ownerName);

        await dataLayer.createNewLock(lockItem);
        const putParams = documentClientMock.put.mock.calls[0][0];

        expect(putParams["TableName"]).toBe(lockTableConfig.tableName);
        expect(putParams["Item"][lockTableConfig.partitionKey]).toBe(lockId);
        expect(putParams["Item"][lockTableConfig.sortKey]).toBe(lockGroup);
        expect(putParams["Item"]["ownerName"]).toBe(ownerName);
        expect(putParams["ConditionExpression"]).toBe("attribute_not_exists(#pk) AND attribute_not_exists(#sk)");
        expect(putParams["ExpressionAttributeNames"]).toStrictEqual({
            "#pk": lockTableConfig.partitionKey,
            "#sk": lockTableConfig.sortKey
        });
    });

    it("createLock should set TTL while creating a lock", async () => {
        const ttlKey = "ttl";
        const now = Date.now();
        const minute = 1_000;
        const hour = 60 * 60 * minute;
        const dataLayer = new DataLayer(documentClient, {
            ...lockTableConfig,
            ttlKey,
            ttlInMs: hour // 1 hour
        });
        const lockItem = Lock.create(lockGroup, lockId, ownerName);

        await dataLayer.createNewLock(lockItem);
        const putParams = documentClientMock.put.mock.calls[0][0];
        const ttlValue = putParams["Item"][ttlKey];

        expect(ttlValue).toBeDefined();
        expect(ttlValue).toBeGreaterThan((now + hour - minute) / 1000);
        expect(ttlValue).toBeLessThan((now + hour + minute) / 1000);
    });

    it("updateRecordVersionNumberAndTime should update recordVersionNumber and lastUpdatedTime", async () => {
        const dataLayer = new DataLayer(documentClient, lockTableConfig);
        const lockItem = Lock.create(lockGroup, lockId, ownerName);
        lockItem.recordVersionNumber = v4();
        const newRecordVersionNumber = v4();
        const newLastUpdatedDate = new Date();

        await dataLayer.updateRecordVersionNumberAndTime(lockItem, newRecordVersionNumber, newLastUpdatedDate);
        const updateParams = documentClientMock.update.mock.calls[0][0];

        expect(updateParams["TableName"]).toBe(lockTableConfig.tableName);
        expect(updateParams["Key"]).toStrictEqual({
            [lockTableConfig.partitionKey]: lockId,
            [lockTableConfig.sortKey]: lockGroup
        });
        expect(updateParams["ConditionExpression"]).toBe(
            "attribute_exists(#pk) AND attribute_exists(#sk) AND #recordVersionNumber = :recordVersionNumber AND #ownerName = :ownerName"
        );
        expect(updateParams["UpdateExpression"]).toBe(
            "SET #recordVersionNumber = :newrecordVersionNumber, #lastUpdatedTimeInMs = :newlastUpdatedTimeInMs"
        );
        expect(updateParams["ExpressionAttributeNames"]).toStrictEqual({
            "#pk": lockTableConfig.partitionKey,
            "#sk": lockTableConfig.sortKey,
            "#lastUpdatedTimeInMs": "lastUpdatedTimeInMs",
            "#recordVersionNumber": "recordVersionNumber",
            "#ownerName": "ownerName"
        });
        expect(updateParams["ExpressionAttributeValues"]).toStrictEqual({
            ":newlastUpdatedTimeInMs": newLastUpdatedDate.getTime(),
            ":newrecordVersionNumber": newRecordVersionNumber,
            ":recordVersionNumber": lockItem.recordVersionNumber,
            ":ownerName": lockItem.ownerName
        });
    });

    it("updateRecordVersionNumberAndTime should update TTL if enabled", async () => {
        const ttlInMs = 60 * 60 * 1_000;
        const estimatedTTL = (Date.now() + ttlInMs) / 1000;
        // 400 ms as a buffer for other operations
        const buffer = 400;

        const dataLayer = new DataLayer(documentClient, {
            ...lockTableConfig,
            ttlKey: "ttl",
            ttlInMs
        });

        const lockItem = Lock.create(lockGroup, lockId, ownerName);
        lockItem.recordVersionNumber = v4();
        const newRecordVersionNumber = v4();
        const newLastUpdatedTime = new Date();

        await dataLayer.updateRecordVersionNumberAndTime(lockItem, newRecordVersionNumber, newLastUpdatedTime);
        const updateParams = documentClientMock.update.mock.calls[0][0];

        expect(updateParams["ExpressionAttributeNames"]).toMatchObject({
            "#ttl": "ttl"
        });
        expect(updateParams["ExpressionAttributeValues"]).toHaveProperty(":newttl");
        expect(updateParams["ExpressionAttributeValues"][":newttl"]).toBeLessThan(estimatedTTL + buffer);
        expect(updateParams["ExpressionAttributeValues"][":newttl"]).toBeGreaterThan(estimatedTTL - buffer);
        expect(updateParams["UpdateExpression"]).toMatch(/#ttl = :newttl/);
    });

    it("updateRecordVersionNumberAndTime should not update TTL if not enabled", async () => {
        const dataLayer = new DataLayer(documentClient, lockTableConfig);

        const lockItem = Lock.create(lockGroup, lockId, ownerName);
        lockItem.recordVersionNumber = v4();
        const newRecordVersionNumber = v4();
        const newLastUpdatedTime = new Date();

        await dataLayer.updateRecordVersionNumberAndTime(lockItem, newRecordVersionNumber, newLastUpdatedTime);
        const updateParams = documentClientMock.update.mock.calls[0][0];

        expect(updateParams["ExpressionAttributeNames"]).not.toMatchObject({
            "#ttl": "ttl"
        });
        expect(updateParams["ExpressionAttributeValues"]).not.toHaveProperty(":newttl");
        expect(updateParams["UpdateExpression"]).not.toMatch(/#ttl = :newttl/);
    });

    it("updateLockWithNewLockContent should update the existing lock's content with the new one", async () => {
        const now = Date.now();
        const dataLayer = new DataLayer(documentClient, lockTableConfig);
        const existingLock = Lock.create(lockGroup, lockId, ownerName);
        const existingRecordVersionNumber = v4();
        existingLock.recordVersionNumber = existingRecordVersionNumber;
        const newRecordVersionNumber = v4();
        const newLeaseDuration = 15_000;
        const newLock = Lock.create(lockGroup, lockId, ownerName, undefined, now, false, {
            leaseDurationInMs: newLeaseDuration
        });
        newLock.recordVersionNumber = newRecordVersionNumber;

        await dataLayer.updateLockWithNewLockContent(existingLock, newLock);
        const updateParams = documentClientMock.update.mock.calls[0][0];

        expect(updateParams["TableName"]).toBe(lockTableConfig.tableName);
        expect(updateParams["Key"]).toStrictEqual({
            [lockTableConfig.partitionKey]: lockId,
            [lockTableConfig.sortKey]: lockGroup
        });
        expect(updateParams["ConditionExpression"]).toBe(
            "attribute_exists(#pk) AND attribute_exists(#sk) AND #recordVersionNumber = :recordVersionNumber"
        );
        expect(updateParams["UpdateExpression"]).toBe(
            "SET #recordVersionNumber = :newrecordVersionNumber, #ownerName = :newownerName, #lastUpdatedTimeInMs = :newlastUpdatedTimeInMs, #leaseDurationInMs = :newleaseDurationInMs, #additionalAttributes = :newadditionalAttributes"
        );
        expect(updateParams["ExpressionAttributeNames"]).toStrictEqual({
            "#pk": lockTableConfig.partitionKey,
            "#sk": lockTableConfig.sortKey,
            "#additionalAttributes": "additionalAttributes",
            "#leaseDurationInMs": "leaseDurationInMs",
            "#lastUpdatedTimeInMs": "lastUpdatedTimeInMs",
            "#recordVersionNumber": "recordVersionNumber",
            "#ownerName": "ownerName"
        });
        expect(updateParams["ExpressionAttributeValues"][":recordVersionNumber"]).toBe(existingRecordVersionNumber);
        expect(updateParams["ExpressionAttributeValues"][":newrecordVersionNumber"]).toBe(newRecordVersionNumber);
        expect(updateParams["ExpressionAttributeValues"][":newleaseDurationInMs"]).toBe(newLeaseDuration);
        expect(updateParams["ExpressionAttributeValues"][":newlastUpdatedTimeInMs"]).toBe(now);
    });

    it("updateLockWithNewLockContent should update TTL if enabled", async () => {
        const now = Date.now();
        const ttlInMs = 60 * 60 * 1_000;
        const estimatedTTL = (now + ttlInMs) / 1000;
        // 400 ms as a buffer for other operations
        const buffer = 400;
        const dataLayer = new DataLayer(documentClient, {
            ...lockTableConfig,
            ttlKey: "ttl",
            ttlInMs
        });

        const existingLock = Lock.create(lockGroup, lockId, ownerName);
        existingLock.recordVersionNumber = v4();
        const newRecordVersionNumber = v4();
        const newLock = Lock.create(lockGroup, lockId, ownerName, undefined, now, false);
        newLock.recordVersionNumber = newRecordVersionNumber;

        await dataLayer.updateLockWithNewLockContent(existingLock, newLock);
        const updateParams = documentClientMock.update.mock.calls[0][0];

        expect(updateParams["ExpressionAttributeNames"]).toMatchObject({
            "#ttl": "ttl"
        });
        expect(updateParams["ExpressionAttributeValues"]).toHaveProperty(":newttl");
        expect(updateParams["ExpressionAttributeValues"][":newttl"]).toBeLessThan(estimatedTTL + buffer);
        expect(updateParams["ExpressionAttributeValues"][":newttl"]).toBeGreaterThan(estimatedTTL - buffer);
        expect(updateParams["UpdateExpression"]).toMatch(/#ttl = :newttl/);
    });

    it("updateLockWithNewLockContent should not update TTL if not enabled", async () => {
        const dataLayer = new DataLayer(documentClient, lockTableConfig);

        const existingLock = Lock.create(lockGroup, lockId, ownerName);
        existingLock.recordVersionNumber = v4();
        const newRecordVersionNumber = v4();
        const newLock = Lock.create(lockGroup, lockId, ownerName, undefined, Date.now(), false);
        newLock.recordVersionNumber = newRecordVersionNumber;

        await dataLayer.updateLockWithNewLockContent(existingLock, newLock);
        const updateParams = documentClientMock.update.mock.calls[0][0];

        expect(updateParams["ExpressionAttributeNames"]).not.toMatchObject({
            "#ttl": "ttl"
        });
        expect(updateParams["ExpressionAttributeValues"]).not.toHaveProperty(":newttl");
        expect(updateParams["UpdateExpression"]).not.toMatch(/#ttl = :newttl/);
    });

    it("deleteLock should delete a lock with correct params", async () => {
        const dataLayer = new DataLayer(documentClient, lockTableConfig);
        const lockItem = Lock.create(lockGroup, lockId, ownerName);
        lockItem.recordVersionNumber = v4();

        await dataLayer.deleteLock(lockItem);
        const deleteParams = documentClientMock.delete.mock.calls[0][0];

        expect(deleteParams["TableName"]).toBe(lockTableConfig.tableName);
        expect(deleteParams["Key"]).toStrictEqual({
            [lockTableConfig.partitionKey]: lockId,
            [lockTableConfig.sortKey]: lockGroup
        });
        expect(deleteParams["ConditionExpression"]).toBe(
            "attribute_exists(#pk) AND attribute_exists(#sk) AND #recordVersionNumber = :recordVersionNumber AND #ownerName = :ownerName"
        );
        expect(deleteParams["ExpressionAttributeNames"]).toStrictEqual({
            "#pk": lockTableConfig.partitionKey,
            "#sk": lockTableConfig.sortKey,
            "#recordVersionNumber": "recordVersionNumber",
            "#ownerName": "ownerName"
        });
        expect(deleteParams["ExpressionAttributeValues"]).toStrictEqual({
            ":recordVersionNumber": lockItem.recordVersionNumber,
            ":ownerName": lockItem.ownerName
        });
    });
});
