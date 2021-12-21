const jestConfig = require("./jest.config");

module.exports = {
    ...jestConfig,
    collectCoverage: true,
    roots: [
        "<rootDir>/src",
        "<rootDir>/test/e2e"
    ]
};
