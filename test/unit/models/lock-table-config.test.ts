import {LockTableConfig} from "../../../src/model/lock-table-config";
import {RESERVED_ATTRS} from "../../../src/data-layer";
import {LockTableConfigValidationError} from "../../../src/model/errors";

describe("LockTableConfig", () => {
    it("should throw error if partitionKey, sortKey or ttlKey are set to reserved words while initializing", () => {
        const attrs = ["partitionKey", "sortKey", "ttlKey"];
        for (const attr of attrs) {
            for (const reservedAttrName of RESERVED_ATTRS) {
                expect(() => {
                    LockTableConfig.create({
                        tableName: "someTableName",
                        [attr]: reservedAttrName
                    });
                }).toThrowError(LockTableConfigValidationError);
            }
        }
    });

    it("should create a lockTableConfig instance", () => {
        expect(
            LockTableConfig.create({
                tableName: "someTableName",
                partitionKey: "partitionKey",
                sortKey: "sortKey",
                ttlKey: "ttlKey"
            })
        ).toBeInstanceOf(LockTableConfig);
    });

    it("should create a lockTableConfig instance with default values", () => {
        const lockTableConfig = LockTableConfig.create();
        expect(lockTableConfig.tableName).toBe("LockTable");
        expect(lockTableConfig.partitionKey).toBe("lockId");
        expect(lockTableConfig.sortKey).toBe("lockGroup");
    });
});
