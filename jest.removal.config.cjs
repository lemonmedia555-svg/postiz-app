const { pathsToModuleNameMapper } = require('ts-jest');
const { compilerOptions } = require('./tsconfig.base.json');
module.exports = {
  testEnvironment: 'node',
  testMatch: ['<rootDir>/tests/removal/*.spec.ts'],
  testPathIgnorePatterns: ['/node_modules/', '/\\._'],
  transform: { '^.+\\.tsx?$': ['ts-jest', {
    tsconfig: { ...compilerOptions, module: 'commonjs', incremental: false, isolatedModules: true },
  }] },
  moduleNameMapper: pathsToModuleNameMapper(compilerOptions.paths, { prefix: '<rootDir>/' }),
  maxWorkers: 1,
  testTimeout: 30000,
};
