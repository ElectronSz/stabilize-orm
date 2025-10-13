import { Model, Column, Required } from "../../src";

@Model("roles")
export class Role {
  @Column("id", "INTEGER")
  id?: number;

  @Column("name", "TEXT")
  @Required()
  name?: string;
}
