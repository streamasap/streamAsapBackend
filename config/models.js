import { DataTypes } from "sequelize";
import sequelize from "./db.js";

const User = sequelize.define("User", {
    id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
    name: { type: DataTypes.STRING, allowNull: false, },
    phone: { type: DataTypes.STRING, allowNull: false, unique: true, },
    email: { type: DataTypes.STRING, allowNull: false, unique: true, validate: { isEmail: true, }, },
    joinDate: { type: DataTypes.DATE, defaultValue: DataTypes.NOW, },
    country: { type: DataTypes.STRING, allowNull: false, },
    status: { type: DataTypes.ENUM("Active", "Suspended", "Pending"), defaultValue: "Pending", },
    role: { type: DataTypes.ENUM("user", "producer"), allowNull: false, defaultValue: "user", },
}, {
    tableName: "users",
    timestamps: true,
});

const Subscription = sequelize.define("Subscription", {
    id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true, },
    userId: {
        type: DataTypes.UUID, allowNull: false,
        references: {
            model: "users",
            key: "id",
        },
        onDelete: "CASCADE",
    },
    date: { type: DataTypes.DATE, defaultValue: DataTypes.NOW, },
    type: { type: DataTypes.ENUM("user", "producer"), allowNull: false, },
    status: { type: DataTypes.ENUM("Pending", "Completed", "Running", "Failed"), defaultValue: "Pending", },
    details: { type: DataTypes.JSONB, allowNull: false, defaultValue: {}, },
}, {
    tableName: "subscriptions",
    timestamps: true,
});


export {
    Subscription, sequelize,
    User
};
