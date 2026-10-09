import dotenv from "dotenv";
import { Sequelize } from "sequelize";

dotenv.config({ quiet: true});

const sequelize = new Sequelize(process.env.DATABASE_URL, {
  dialect: "postgres",
//   protocol: "postgres",
  logging: false,
  dialectOptions: {
    ssl: {
      require: true,
      rejectUnauthorized: false, // important for Supabase
    },
  },
});

export default sequelize;