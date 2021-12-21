import {DynamoDB} from "aws-sdk";
import {LockTableConfig} from "./model/lock-table-config";
import {Lock} from "./model/lock";

const PK_PATH_EXPRESSION_VARIABLE = "#pk";
const SK_PATH_EXPRESSION_VARIABLE = "#sk";

type LockTableAttrs = {
    recordVersionNumber: string;
    ownerName: string;
    lastUpdatedTimeInMs: number;
    leaseDurationInMs: number;
    additionalAttributes: DynamoDB.DocumentClient.AttributeMap;
};

export const ATTRS: {[Property in keyof LockTableAttrs]: Property} = {
    recordVersionNumber: "recordVersionNumber",
    ownerName: "ownerName",
    lastUpdatedTimeInMs: "lastUpdatedTimeInMs",
    leaseDurationInMs: "leaseDurationInMs",
    additionalAttributes: "additionalAttributes"
};

// Avoid type narrowing with defining as string[]
export const RESERVED_ATTRS: string[] = Object.values(ATTRS);

const PATH_EXPRESSION = (recordKey: string) => `#${recordKey}`;
const VALUE_EXPRESSION = (recordKey: string) => `:${recordKey}`;
const UPDATE_VALUE_EXPRESSION = (recordKey: string) => `:new${recordKey}`;
const UPDATE_EXPRESSION = (recordKeys: string[]) =>
    `SET ${recordKeys
        .map((recordKey) => `${PATH_EXPRESSION(recordKey)} = ${UPDATE_VALUE_EXPRESSION(recordKey)}`)
        .join(", ")}`;

// attribute_not_exists(#pk) AND attribute_not_exists(#sk)
const ACQUIRE_LOCK_THAT_DOESNT_EXIST_CONDITION = `attribute_not_exists(${PK_PATH_EXPRESSION_VARIABLE}) AND attribute_not_exists(${SK_PATH_EXPRESSION_VARIABLE})`;

// attribute_exists(#pk) AND attribute_exists(#sk)
const LOCK_EXIST_CONDITION = `attribute_exists(${PK_PATH_EXPRESSION_VARIABLE}) AND attribute_exists(${SK_PATH_EXPRESSION_VARIABLE})`;

// attribute_exists(#pk) AND attribute_exists(#sk) AND #recordVersionNumber = :recordVersionNumber
const LOCK_EXIST_AND_RVN_SAME_CONDITION = `${LOCK_EXIST_CONDITION} AND ${PATH_EXPRESSION(
    ATTRS.recordVersionNumber
)} = ${VALUE_EXPRESSION(ATTRS.recordVersionNumber)}`;

// attribute_exists(#pk) AND attribute_exists(#sk) AND #recordVersionNumber = :recordVersionNumber
// AND #ownerName = :ownerName
const LOCK_EXIST_AND_RVN_AND_OWNER_NAME_SAME_CONDITION = `${LOCK_EXIST_AND_RVN_SAME_CONDITION} AND ${PATH_EXPRESSION(
    ATTRS.ownerName
)} = ${VALUE_EXPRESSION(ATTRS.ownerName)}`;

export class DataLayer {
    constructor(private documentClient: DynamoDB.DocumentClient, private config: LockTableConfig) {}

    async getLockByGroupAndId(lockGroup: string, lockId: string): Promise<LockTableAttrs | undefined> {
        const params = {
            TableName: this.config.tableName,
            Key: {
                [this.config.partitionKey]: lockId,
                [this.config.sortKey]: lockGroup
            },
            ConsistentRead: true
        };

        const {Item} = await this.documentClient.get(params).promise();
        if (!Item) {
            return;
        }

        return Item as LockTableAttrs;
    }

    async createNewLock(lockItem: Lock): Promise<void> {
        const attrValues = {
            [ATTRS.recordVersionNumber]: lockItem.recordVersionNumber,
            [ATTRS.ownerName]: lockItem.ownerName,
            [ATTRS.lastUpdatedTimeInMs]: lockItem.lastUpdatedTimeInMs,
            [ATTRS.leaseDurationInMs]: lockItem.leaseDurationInMs,
            [ATTRS.additionalAttributes]: lockItem.additionalAttributes
        } as LockTableAttrs;

        const params = {
            TableName: this.config.tableName,
            Item: {
                ...attrValues,
                [this.config.partitionKey]: lockItem.lockId,
                [this.config.sortKey]: lockItem.lockGroup
            },
            ConditionExpression: ACQUIRE_LOCK_THAT_DOESNT_EXIST_CONDITION,
            ExpressionAttributeNames: {
                [PK_PATH_EXPRESSION_VARIABLE]: this.config.partitionKey,
                [SK_PATH_EXPRESSION_VARIABLE]: this.config.sortKey
            }
        };

        if (this.config.ttlKey) {
            params.Item = {
                ...params.Item,
                [this.config.ttlKey]: this.calculateTTL()
            };
        }

        await this.documentClient.put(params).promise();
    }

    async updateRecordVersionNumberAndTime(
        existingLock: Lock,
        newRecordVersionNumber: string,
        when: Date
    ): Promise<void> {
        const {lockGroup, lockId, ownerName, recordVersionNumber} = existingLock;
        // Update the lock with newRecordVersionNumber and updatedAt only if:
        // 1. lockGroup|lockId exist
        // 2. ownerName and recordVersionNumber are equal to current version
        const params = {
            TableName: this.config.tableName,
            Key: {
                [this.config.partitionKey]: lockId,
                [this.config.sortKey]: lockGroup
            },
            ConditionExpression: LOCK_EXIST_AND_RVN_AND_OWNER_NAME_SAME_CONDITION,
            ExpressionAttributeNames: {
                [PK_PATH_EXPRESSION_VARIABLE]: this.config.partitionKey,
                [SK_PATH_EXPRESSION_VARIABLE]: this.config.sortKey,
                [PATH_EXPRESSION(ATTRS.recordVersionNumber)]: ATTRS.recordVersionNumber,
                [PATH_EXPRESSION(ATTRS.ownerName)]: ATTRS.ownerName,
                [PATH_EXPRESSION(ATTRS.lastUpdatedTimeInMs)]: ATTRS.lastUpdatedTimeInMs
            },
            ExpressionAttributeValues: {
                [VALUE_EXPRESSION(ATTRS.recordVersionNumber)]: recordVersionNumber,
                [VALUE_EXPRESSION(ATTRS.ownerName)]: ownerName,
                [UPDATE_VALUE_EXPRESSION(ATTRS.recordVersionNumber)]: newRecordVersionNumber,
                [UPDATE_VALUE_EXPRESSION(ATTRS.lastUpdatedTimeInMs)]: when.getTime()
            },
            UpdateExpression: UPDATE_EXPRESSION([ATTRS.recordVersionNumber, ATTRS.lastUpdatedTimeInMs])
        };

        const paramsWithTTL = this.updateTTLIfEnabled(params);
        await this.documentClient.update(paramsWithTTL).promise();
    }

    async updateLockWithNewLockContent(existingLock: Lock, newLock: Lock): Promise<void> {
        // Try update the existingLock with with the new lock content
        // 1. lockGroup|lockId exist
        // 2. recordVersionNumber are still same (Possible issue: existingLock sent a request for prolonging lease and recordVersionNumber updated)
        // which means there is no request for prolonging lease from the existing lock
        // 3. Update all attributes
        const params = {
            TableName: this.config.tableName,
            Key: {
                [this.config.partitionKey]: existingLock.lockId,
                [this.config.sortKey]: existingLock.lockGroup
            },
            ConditionExpression: LOCK_EXIST_AND_RVN_SAME_CONDITION,
            ExpressionAttributeNames: {
                [PK_PATH_EXPRESSION_VARIABLE]: this.config.partitionKey,
                [SK_PATH_EXPRESSION_VARIABLE]: this.config.sortKey,
                [PATH_EXPRESSION(ATTRS.recordVersionNumber)]: ATTRS.recordVersionNumber,
                [PATH_EXPRESSION(ATTRS.ownerName)]: ATTRS.ownerName,
                [PATH_EXPRESSION(ATTRS.lastUpdatedTimeInMs)]: ATTRS.lastUpdatedTimeInMs,
                [PATH_EXPRESSION(ATTRS.leaseDurationInMs)]: ATTRS.leaseDurationInMs,
                [PATH_EXPRESSION(ATTRS.additionalAttributes)]: ATTRS.additionalAttributes
            },
            ExpressionAttributeValues: {
                [VALUE_EXPRESSION(ATTRS.recordVersionNumber)]: existingLock.recordVersionNumber,
                [UPDATE_VALUE_EXPRESSION(ATTRS.recordVersionNumber)]: newLock.recordVersionNumber,
                [UPDATE_VALUE_EXPRESSION(ATTRS.ownerName)]: newLock.ownerName,
                [UPDATE_VALUE_EXPRESSION(ATTRS.lastUpdatedTimeInMs)]: newLock.lastUpdatedTimeInMs,
                [UPDATE_VALUE_EXPRESSION(ATTRS.leaseDurationInMs)]: newLock.leaseDurationInMs,
                [UPDATE_VALUE_EXPRESSION(ATTRS.additionalAttributes)]: newLock.additionalAttributes
            },
            UpdateExpression: UPDATE_EXPRESSION([
                ATTRS.recordVersionNumber,
                ATTRS.ownerName,
                ATTRS.lastUpdatedTimeInMs,
                ATTRS.leaseDurationInMs,
                ATTRS.additionalAttributes
            ])
        };

        const paramsWithTTL = this.updateTTLIfEnabled(params);
        await this.documentClient.update(paramsWithTTL).promise();
    }

    async deleteLock(lockItem: Lock): Promise<void> {
        const {lockGroup, lockId, ownerName, recordVersionNumber} = lockItem;

        const params = {
            TableName: this.config.tableName,
            Key: {
                [this.config.partitionKey]: lockId,
                [this.config.sortKey]: lockGroup
            },
            ConditionExpression: LOCK_EXIST_AND_RVN_AND_OWNER_NAME_SAME_CONDITION,
            ExpressionAttributeNames: {
                [PK_PATH_EXPRESSION_VARIABLE]: this.config.partitionKey,
                [SK_PATH_EXPRESSION_VARIABLE]: this.config.sortKey,
                [PATH_EXPRESSION(ATTRS.recordVersionNumber)]: ATTRS.recordVersionNumber,
                [PATH_EXPRESSION(ATTRS.ownerName)]: ATTRS.ownerName
            },
            ExpressionAttributeValues: {
                [VALUE_EXPRESSION(ATTRS.recordVersionNumber)]: recordVersionNumber,
                [VALUE_EXPRESSION(ATTRS.ownerName)]: ownerName
            }
        };

        await this.documentClient.delete(params).promise();
    }

    private updateTTLIfEnabled(
        params: DynamoDB.DocumentClient.UpdateItemInput
    ): DynamoDB.DocumentClient.UpdateItemInput {
        if (!this.config.ttlKey) {
            return params;
        }

        const ttlPath = PATH_EXPRESSION(this.config.ttlKey);
        const ttlUpdateExpression = UPDATE_VALUE_EXPRESSION(this.config.ttlKey);

        return {
            ...params,
            ExpressionAttributeNames: {
                ...params.ExpressionAttributeNames,
                [ttlPath]: this.config.ttlKey
            },
            ExpressionAttributeValues: {
                ...params.ExpressionAttributeValues,
                [ttlUpdateExpression]: this.calculateTTL()
            },
            UpdateExpression: `${params.UpdateExpression}, ${ttlPath} = ${ttlUpdateExpression}`
        };
    }

    private calculateTTL(): number {
        return Math.round((Date.now() + this.config.ttlInMs) / 1000);
    }
}
