import dotenv from 'dotenv';
import express from 'express';
import jwt from 'jsonwebtoken';

import logger from "../config/logger.js";
import { User } from "../config/models.js";
import redis from '../config/redis.js';
import twilioClient from '../config/twilio.js';

dotenv.config({ quiet: true });

const router = express.Router();

const MOVIEZONE_BASE_URL = process.env.MOVIEZONE_BASE_URL;
const MOVIEZONE_API_KEY = process.env.MOVIEZONE_API_KEY;

// Cache TTL Configurations (in seconds)
const TTL_HOME = 15 * 60;          // 15 Minutes for Home Catalog
const TTL_TITLE = 60 * 60;         // 1 Hour for Title Metadata
const TTL_SEASONS = 2 * 60 * 60;    // 2 Hours for Season Episode Lists
const TTL_STREAMS = 30 * 60;       // 30 Minutes for Video Stream Links

// ==========================================
// AUTHENTICATION ROUTES
// ==========================================

// Send OTP
router.post('/auth/send-otp', async (req, res) => {
  const { phone } = req.body;
  if (!phone) return res.status(400).json({ error: "Phone number is required." });

  try {
    const code = Math.floor(100000 + Math.random() * 900000).toString();
    const redisKey = `otp:${phone}`;

    await redis.set(redisKey, code, 'EX', 300);

    logger.info(`OTP generated for ${phone}: ${code}`);
    
    // send code to user phone using twilio

    return res.status(200).json({
      success: true,
      message: "OTP dispatched successfully.",
    });

  } catch (error) {
    logger.error("Send OTP Error:", error);
    return res.status(500).json({ success: false, error: error.message });
  }
});

// Verify OTP, Save to Redis & Database
router.post('/auth/verify-otp', async (req, res) => {
  const { phone, code } = req.body;

  if (!phone || !code) {
    return res.status(400).json({ error: "Phone number and code are required." });
  }

  try {
    const redisKey = `otp:${phone}`;
    const storedCode = await redis.get(redisKey);

    if (!storedCode || storedCode !== code) {
      return res.status(400).json({ success: false, message: "Invalid or expired OTP." });
    }

    await redis.del(redisKey);

    const [dbUser, created] = await User.findOrCreate({
      where: { phone },
      defaults: {
        phone,
        name: `User_${phone.slice(-4)}`,
        email: `${phone.replace(/[^0-9]/g, '')}@streamasap.com`,
        country: 'NG',
        status: 'Active',
        role: 'user',
      },
    });

    const userPayload = {
      id: dbUser.id,
      name: dbUser.name,
      email: dbUser.email,
      phone: dbUser.phone,
      country: dbUser.country,
      status: dbUser.status,
      role: dbUser.role,
      joinDate: dbUser.joinDate,
    };

    await redis.set(`user:session:${dbUser.id}`, JSON.stringify(userPayload), 'EX', 30 * 24 * 60 * 60);

    const token = jwt.sign(
      userPayload,
      process.env.JWT_SECRET || 'secret_key',
      { expiresIn: '30d' }
    );

    return res.status(200).json({
      success: true,
      message: "OTP verified successfully!",
      token,
      user: userPayload,
      isNewUser: created
    });

  } catch (error) {
    logger.error("Verify OTP Error:", error);
    return res.status(500).json({ success: false, error: error.message });
  }
});

// Personalization Profile Update
router.patch('/auth/profile1', async (req, res) => {
  try {
    const { phone, name } = req.body;

    if (!phone) {
      return res.status(400).json({ success: false, message: 'Phone number required' });
    }

    let user = await User.findOne({ where: { phone } });
    if (!user) {
      return res.status(404).json({ success: false, message: 'User not found' });
    }

    if (name) {
      user.name = name;
      await user.save();
    }

    const sessionKey = `session:${phone}`;
    const existingSession = await redis.get(sessionKey);

    let sessionData = existingSession ? JSON.parse(existingSession) : {};
    sessionData = {
      ...sessionData,
      id: user.id,
      phone: user.phone,
      name: user.name,
      joinDate: user.joinDate,
      updatedAt: new Date().toISOString(),
    };

    await redis.set(sessionKey, JSON.stringify(sessionData), 'EX', 30 * 24 * 60 * 60);

    return res.status(200).json({
      success: true,
      user: {
        id: user.id,
        phone: user.phone,
        name: user.name,
        email: user.email,
        joinDate: user.joinDate,
      },
    });
  } catch (error) {
    console.error('Error updating profile:', error);
    return res.status(500).json({ success: false, message: 'Server error updating profile' });
  }
});

// ==========================================
// MOVIEZONE CATALOG & STREAM ROUTES (WITH REDIS CACHING)
// ==========================================

// 1. Fetch Home Catalog (Trending, Recommendations)
router.get('/movies/home', async (req, res) => {
  const cacheKey = 'moviezone:home';

  try {
    // Check Redis cache first
    const cachedData = await redis.get(cacheKey);
    if (cachedData) {
      logger.info('Serving /movies/home from Redis cache');
      return res.status(200).json(JSON.parse(cachedData));
    }

    // Cache miss - Fetch from MovieZone API
    const response = await fetch(`${MOVIEZONE_BASE_URL}/home`, {
      headers: { 'X-API-Key': MOVIEZONE_API_KEY },
    });

    const payload = await response.json();

    if (!response.ok) {
      logger.error(`MovieZone API Error: ${response.status}`, payload);
      return res.status(response.status).json({
        success: false,
        message: payload.message || 'MovieZone API Error',
      });
    }

    const responsePayload = {
      success: true,
      data: payload.data,
    };

    // Store in Redis (15 mins TTL)
    await redis.set(cacheKey, JSON.stringify(responsePayload), 'EX', TTL_HOME);

    return res.status(200).json(responsePayload);
  } catch (error) {
    logger.error('Error fetching MovieZone homepage data:', error);
    return res.status(500).json({
      success: false,
      message: 'Server failed to connect to MovieZone API',
    });
  }
});

// 2. Fetch Title Metadata (Details, Subject, Seasons)
router.get('/movies/titles/:id', async (req, res) => {
  const { id } = req.params;
  const cacheKey = `moviezone:title:${id}`;

  try {
    const cachedData = await redis.get(cacheKey);
    if (cachedData) {
      return res.status(200).json(JSON.parse(cachedData));
    }

    const response = await fetch(`${MOVIEZONE_BASE_URL}/titles/${id}`, {
      headers: { 'X-API-Key': MOVIEZONE_API_KEY },
    });
    const payload = await response.json();

    if (response.ok) {
      await redis.set(cacheKey, JSON.stringify(payload), 'EX', TTL_TITLE);
    }

    return res.status(response.status).json(payload);
  } catch (error) {
    logger.error(`Error fetching title ${req.params.id}:`, error);
    return res.status(500).json({ status: 'error', message: 'Failed to fetch title details' });
  }
});

// 3. Fetch Series Season Episodes
router.get('/movies/series/:tmdbId/seasons/:season', async (req, res) => {
  const { tmdbId, season } = req.params;
  const cacheKey = `moviezone:series:${tmdbId}:season:${season}`;

  try {
    const cachedData = await redis.get(cacheKey);
    if (cachedData) {
      return res.status(200).json(JSON.parse(cachedData));
    }

    const response = await fetch(`${MOVIEZONE_BASE_URL}/series/${tmdbId}/seasons/${season}`, {
      headers: { 'X-API-Key': MOVIEZONE_API_KEY },
    });
    const payload = await response.json();

    if (response.ok) {
      await redis.set(cacheKey, JSON.stringify(payload), 'EX', TTL_SEASONS);
    }

    return res.status(response.status).json(payload);
  } catch (error) {
    logger.error(`Error fetching season ${season} for series ${tmdbId}:`, error);
    return res.status(500).json({ status: 'error', message: 'Failed to fetch season episodes' });
  }
});

// 4. Fetch Video Stream URL (Movie or Series Episode)
// 4. Fetch Video Stream URL (Movie or Series Episode)
router.get('/movies/streams/:id', async (req, res) => {
  const { id } = req.params;
  const { season, episode } = req.query;

  const cacheKey = season && episode
    ? `moviezone:stream:${id}:s${season}:e${episode}`
    : `moviezone:stream:${id}`;

  try {
    // Check Redis cache first
    const cachedData = await redis.get(cacheKey);
    if (cachedData) {
      return res.status(200).json(JSON.parse(cachedData));
    }

    let url = `${MOVIEZONE_BASE_URL}/streams/${id}`;
    if (season && episode) {
      url += `?season=${season}&episode=${episode}`;
    }

    const response = await fetch(url, {
      headers: { 'X-API-Key': MOVIEZONE_API_KEY },
    });
    const payload = await response.json();

    // ONLY cache if response is successful and contains data
    if (response.ok && payload) {
      await redis.set(cacheKey, JSON.stringify(payload), 'EX', TTL_STREAMS);
    }

    return res.status(response.status).json(payload);
  } catch (error) {
    logger.error(`Error fetching stream for title ${id}:`, error);
    return res.status(500).json({ status: 'error', message: 'Failed to fetch video stream' });
  }
});

// GET /api/movies/cache/flush-streams
router.get('/movies/cache/flush-streams', async (req, res) => {
  try {
    const keys = await redis.keys('moviezone:stream:*');
    if (keys.length > 0) {
      await redis.del(...keys);
    }
    logger.info(`Flushed ${keys.length} cached stream keys from Redis`);
    return res.status(200).json({
      success: true,
      message: `Successfully cleared ${keys.length} cached stream keys.`,
    });
  } catch (error) {
    logger.error('Error flushing stream cache:', error);
    return res.status(500).json({ success: false, error: error.message });
  }
});

// GET /api/movies/titles/:id/related
router.get('/movies/titles/:id/related', async (req, res) => {
  const { id } = req.params;
  const cacheKey = `moviezone:title:${id}:related`;

  try {
    // 1. Check Redis Cache
    const cachedData = await redis.get(cacheKey);
    if (cachedData) {
      return res.status(200).json(JSON.parse(cachedData));
    }

    // 2. Query MovieZone Partner API for related / recommendations
    let response = await fetch(`${MOVIEZONE_BASE_URL}/titles/${id}/related`, {
      headers: { 'X-API-Key': MOVIEZONE_API_KEY },
    });

    let payload = await response.json();

    // 3. Fallback: If MovieZone has no specific related list, fetch home recommendations
    if (!response.ok || !payload.data || payload.data.length === 0) {
      const homeRes = await fetch(`${MOVIEZONE_BASE_URL}/home`, {
        headers: { 'X-API-Key': MOVIEZONE_API_KEY },
      });
      const homePayload = await homeRes.json();
      
      payload = {
        status: 'success',
        data: homePayload.data?.recommendations || homePayload.data?.trending || [],
      };
    }

    // 4. Save to Redis for 1 Hour
    await redis.set(cacheKey, JSON.stringify(payload), 'EX', TTL_TITLE);

    return res.status(200).json(payload);
  } catch (error) {
    logger.error(`Error fetching related content for ${id}:`, error);
    return res.status(500).json({ status: 'error', message: 'Failed to fetch related movies' });
  }
});

// GET /api/movies/search?query=...&genre=...
router.get('/movies/search', async (req, res) => {
  const { query = '', genre = '' } = req.query;
  const cleanQuery = query.trim().toLowerCase();
  const cleanGenre = genre === 'All' ? '' : genre.trim().toLowerCase();

  const cacheKey = `moviezone:search:q=${cleanQuery}:g=${cleanGenre}`;

  try {
    // 1. Check Redis Cache
    const cachedData = await redis.get(cacheKey);
    if (cachedData) {
      logger.info(`Serving search from Redis: q="${cleanQuery}", g="${cleanGenre}"`);
      return res.status(200).json(JSON.parse(cachedData));
    }

    let searchList = [];

    // 2. Query MovieZone Partner Search API
    if (cleanQuery || cleanGenre) {
      let searchUrl = `${MOVIEZONE_BASE_URL}/search?`;
      if (cleanQuery) searchUrl += `query=${encodeURIComponent(cleanQuery)}&`;
      if (cleanGenre) searchUrl += `genre=${encodeURIComponent(cleanGenre)}`;

      const response = await fetch(searchUrl, {
        headers: { 'X-API-Key': MOVIEZONE_API_KEY },
      });

      if (response.ok) {
        const payload = await response.json();
        searchList =
          payload.data?.results ||
          payload.data?.subjects ||
          payload.data?.trending ||
          payload.data ||
          payload.results ||
          (Array.isArray(payload) ? payload : []);
      }
    }

    // 3. Fallback Layer: If provider API returned 0 items (e.g. for "action", "vikings", "aquaman")
    if (!Array.isArray(searchList) || searchList.length === 0) {
      logger.info(`Provider API returned empty for "${cleanQuery}". Executing fallback catalog filter...`);

      // Fetch fresh or cached home catalog
      const homeRes = await fetch(`${MOVIEZONE_BASE_URL}/home`, {
        headers: { 'X-API-Key': MOVIEZONE_API_KEY },
      });
      const homePayload = await homeRes.json();

      const catalogPool = [
        ...(homePayload.data?.trending || []),
        ...(homePayload.data?.recommendations || []),
        ...(homePayload.data?.continueWatching || []),
      ];

      // Remove duplicates by ID
      const uniqueCatalog = Array.from(
        new Map(catalogPool.map((item) => [item.id, item])).values()
      );

      searchList = uniqueCatalog.filter((item) => {
        const itemTitle = (item.title || item.name || '').toLowerCase();
        const itemGenre = (item.genre || '').toLowerCase();
        const itemOverview = (item.overview || item.description || '').toLowerCase();

        // Check if query matches Title, Genre, or Overview description
        const matchesQuery = cleanQuery
          ? itemTitle.includes(cleanQuery) ||
            itemGenre.includes(cleanQuery) ||
            itemOverview.includes(cleanQuery) ||
            // Handle plural singular stem variations (e.g., "vikings" matches "viking")
            cleanQuery.startsWith(itemTitle) ||
            itemTitle.startsWith(cleanQuery.slice(0, 4))
          : true;

        // Check if selected chip genre matches
        const matchesGenre = cleanGenre
          ? itemGenre.includes(cleanGenre)
          : true;

        return matchesQuery && matchesGenre;
      });
    }

    const responsePayload = {
      status: 'success',
      data: searchList,
    };

    // 4. Store in Redis for 15 mins
    if (searchList.length > 0) {
      await redis.set(cacheKey, JSON.stringify(responsePayload), 'EX', 15 * 60);
    }

    return res.status(200).json(responsePayload);
  } catch (error) {
    logger.error('Error in search route:', error);
    return res.status(500).json({ status: 'error', message: 'Search execution failed' });
  }
});

export default router;