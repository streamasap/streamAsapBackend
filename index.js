
import dotenv from 'dotenv';
import express from 'express';
import { createServer } from 'http';
// config env variables
dotenv.config({ quiet: true });

import cors from 'cors';
import logger from "./config/logger.js";
import { sequelize } from "./config/models.js";
import routes from "./server/routes.js";

const app = express();
const server = createServer(app);
const PORT = process.env.PORT || 4000;
const SERVERENV = process.env.NODE_ENV;

app.use(cors());
app.use(express.json());

app.use('/api', routes);

app.get('/', (req, res) => {
    res.send('Server is running');
});

// start server
async function startServer() {
    try {
        await sequelize.authenticate();
        logger.info("Database connected successfully");

        if (SERVERENV === "development") {
            await sequelize.sync({ alter: true });
            logger.info("Database synced (DEV mode)");
        }

        server.listen(PORT, () => {
            logger.info(`Server running on port ${PORT}`);
        });

    } catch (error) {
        logger.error("Database connection failed:", error);
    }
}

startServer();

// Graceful Shutdown
const shutdown = async () => {
    logger.warn('Shutting down gracefully...');
    server.close(async () => {
        try {
            await sequelize.close();
            logger.info('Database connection closed.');
            process.exit(0);
        } catch (err) {
            logger.error('Error during shutdown:', err);
            process.exit(1);
        }
    });
};

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);