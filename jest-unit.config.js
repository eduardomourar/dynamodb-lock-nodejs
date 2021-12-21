const jestConfig = require("./jest.config");

module.exports = {
    ...jestConfig,
    roots: [
        "<rootDir>/src",
        "<rootDir>/test/unit"
    ]
};
