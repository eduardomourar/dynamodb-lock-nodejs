import {DataLayer} from "./src/data-layer";
import {DynamoDB} from "aws-sdk";
import {LockTableConfig, LockTableConfigParam} from "./src/model/lock-table-config";
import {LockClient, LogCallbackType} from "./src/lock-client";

export {Lock, LockOptions} from "./src/model/lock";
export {LockClient, LogCallbackType} from "./src/lock-client";
export {LockNotGrantedError, LockOptionsValidationError, LockTableConfigValidationError} from "./src/model/errors";

/**
 * @throws LockTableConfigValidationError
 */
export const dynamoDBLockClientFactory = (
    documentClient: DynamoDB.DocumentClient,
    lockTableConfigParam?: LockTableConfigParam,
    logCallback?: LogCallbackType
): LockClient => {
    const lockTableConfig = LockTableConfig.create(lockTableConfigParam);
    const dataLayer = new DataLayer(documentClient, lockTableConfig);
    return new LockClient(dataLayer, logCallback);
};
