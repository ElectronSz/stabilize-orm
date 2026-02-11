import { describe, it, expect } from 'vitest';
import { Repository } from '../repository';
import { defineModel } from '../model';
import { DataTypes, DBType } from '../types';

describe('Repository validation metadata mapping', () => {
  const User = defineModel({
    tableName: 'users',
    columns: {
      id: { type: DataTypes.INTEGER, required: true },
      username: { type: DataTypes.STRING, minLength: 3 },
      email: {
        type: DataTypes.STRING,
        customValidator: (val: string) => val.endsWith('@example.com') || 'Invalid email domain',
      },
    },
  });

  const fakeClient: any = {
    config: { type: DBType.SQLite },
  };

  it('should enforce minLength from model column metadata', () => {
    const repo = new Repository(fakeClient, User);

    expect(() => (repo as any).validate({ id: 1, username: 'ab' })).toThrow('too short');
  });

  it('should enforce customValidator from model column metadata', () => {
    const repo = new Repository(fakeClient, User);

    expect(() => (repo as any).validate({ id: 1, email: 'test@not-example.com' })).toThrow('Invalid email domain');
  });
});
