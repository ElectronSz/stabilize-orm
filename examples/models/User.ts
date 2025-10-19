import { defineModel, DataTypes } from "../../";

const User = defineModel({
  tableName: "users",
  versioned: true,
  softDelete: true,
  columns: {
    id: { type: DataTypes.INTEGER, required: true },
    username: { type: DataTypes.STRING, length: 255, unique: true, required: true },
    fname: { type: DataTypes.STRING,length: 50, },
    lname: { type: DataTypes.STRING, length: 50, },
    active: { type: DataTypes.BOOLEAN, length: 50, },
  },
  timestamps: {
    createdAt: "createdAt",
    updatedAt: "updatedAt",
  },
  hooks: {
    afterCreate: (entity) => {
      console.log(`User created: ${entity.id}`);
    },
    afterUpdate: async (entity) => {
     console.log(`User updated: ${entity.id}`);
    },
  },
});

export { User };
