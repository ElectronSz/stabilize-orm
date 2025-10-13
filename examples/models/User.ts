import { Model, Column, Required, SoftDelete } from '../../src';

@Model('users')
export class User {
  @Column('id', 'INTEGER')
  id?: number;

  @Column('name', 'TEXT')
  @Required()
  name?: string;

  @Column('email', 'TEXT')
  @Required()
  email?: string;

  @Column('active', 'BOOLEAN')
  active?: boolean;

  @Column('deletedAt', 'TEXT')
  @SoftDelete()
  deletedAt?: string;
}