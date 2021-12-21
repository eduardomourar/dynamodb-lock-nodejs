import {DocumentClient} from "aws-sdk/clients/dynamodb";
import {Credentials, DynamoDB} from "aws-sdk";

const options = {
    endpoint: "http://dynamodb:8000",
    sslEnabled: false,
    region: "local",
    credentials: new Credentials({accessKeyId: "accessKeyId", secretAccessKey: "secretAccessKey"})
};

const lockTable = {
    TableName: "LockTable",
    KeySchema: [
        {
            AttributeName: "lockId",
            KeyType: "HASH"
        },
        {
            AttributeName: "lockGroup",
            KeyType: "RANGE"
        }
    ],
    AttributeDefinitions: [
        {
            AttributeName: "lockId",
            AttributeType: "S"
        },
        {
            AttributeName: "lockGroup",
            AttributeType: "S"
        }
    ],
    ProvisionedThroughput: {
        ReadCapacityUnits: 1,
        WriteCapacityUnits: 1
    }
};

export const createDocumentClient = (): DocumentClient => {
    return new DocumentClient(options);
};

export const createLockTable = async (): Promise<void> => {
    const dynamoDB = new DynamoDB(options);
    await dynamoDB.createTable(lockTable).promise();
    await dynamoDB.waitFor("tableExists", {TableName: lockTable.TableName}).promise();
};

export const destroyLockTable = async (): Promise<void> => {
    const dynamoDB = new DynamoDB(options);
    await dynamoDB.deleteTable({TableName: lockTable.TableName}).promise();
    await dynamoDB.waitFor("tableNotExists", {TableName: lockTable.TableName}).promise();
};
