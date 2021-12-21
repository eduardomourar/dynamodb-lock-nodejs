module.exports = {
    verbose: true,
    collectCoverage: true,
    moduleFileExtensions: [
        "js",
        "json",
        "ts"
    ],
    testRegex: ".test.ts$",
    transform: {
        "^.+\\.ts$": "ts-jest"
    },
    coverageDirectory: "./coverage",
    collectCoverageFrom: [
        "src/**/**"
    ],
    testEnvironment: "node"
}
