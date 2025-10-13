import { DBType, type DBConfig } from '../../src';

const config: DBConfig = {
  type: DBType.SQLite,
  connectionString: 'sqlite://./test.db',
};

export default config;