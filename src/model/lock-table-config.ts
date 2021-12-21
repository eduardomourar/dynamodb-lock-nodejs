import {RESERVED_ATTRS} from "../data-layer";
import {LockTableConfigValidationError} from "./errors";

const HOUR = 60 * 60 * 1_000;

export type LockTableConfigParam = {
    readonly tableName?: string;
    readonly partitionKey?: string;
    readonly sortKey?: string;
    readonly ttlKey?: string;
    readonly ttlInMs?: number;
};

export class LockTableConfig {
    static create(configParam: LockTableConfigParam = {}): LockTableConfig {
        const config = new LockTableConfig(
            configParam.tableName,
            configParam.partitionKey,
            configParam.sortKey,
            configParam.ttlKey,
            configParam.ttlInMs
        );

        if (RESERVED_ATTRS.includes(config.partitionKey)) {
            throw new LockTableConfigValidationError(
                `"${config.partitionKey}" is a reserved word and cannot use as a partitionKey`
            );
        }
        if (RESERVED_ATTRS.includes(config.sortKey)) {
            throw new LockTableConfigValidationError(
                `"${config.partitionKey}" is a reserved word and cannot use as a sortKey`
            );
        }
        if (config.ttlKey && RESERVED_ATTRS.includes(config.ttlKey)) {
            throw new LockTableConfigValidationError(
                `"${config.partitionKey}" is a reserved word and cannot use as a ttlKey`
            );
        }

        return config;
    }

    private constructor(
        readonly tableName: string = "LockTable",
        readonly partitionKey: string = "lockId",
        readonly sortKey: string = "lockGroup",
        // If a lock is not released properly, it ends up staying in DynamoDB lock table, until acquired again.
        // Depending on the locking space (lockIds), table can be polluted (never re-acquired in a short time).
        // In order to avoid those leftovers, DynamoDB cleans those records after TTL expired.
        // Its highly recommended to enable TTL if your lockGroup|lockId space are big.
        readonly ttlKey?: string,
        readonly ttlInMs = HOUR
    ) {}
}
