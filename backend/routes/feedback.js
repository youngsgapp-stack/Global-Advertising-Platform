/**
 * Feedback API: POST /api/feedback (anyone, signed-in optional)
 */
import express from 'express';
import { query } from '../db/init.js';
import { rateLimit } from '../middleware/rate-limit.js';

const router = express.Router();

const FEEDBACK_TYPES = ['general', 'bug', 'feature', 'other'];
const clean = (value, max) => String(value ?? '').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '').trim().slice(0, max);

const feedbackRateLimit = rateLimit({ name: 'feedback', windowMs: 10 * 60 * 1000, max: 5 });

router.post('/', feedbackRateLimit, async (req, res) => {
    const type = FEEDBACK_TYPES.includes(req.body?.type) ? req.body.type : 'general';
    const title = clean(req.body?.title, 120);
    const message = clean(req.body?.message, 2000);
    const ratingNumber = parseInt(req.body?.rating, 10);
    const rating = ratingNumber >= 1 && ratingNumber <= 5 ? ratingNumber : null;
    if (!title || !message) {
        return res.status(400).json({ error: 'Please enter a title and a message.' });
    }
    try {
        const userId = req.user?.uid
            ? (await query(`SELECT id FROM users WHERE firebase_uid = $1`, [req.user.uid])).rows[0]?.id || null
            : null;
        await query(
            `INSERT INTO feedback (user_id, type, title, message, rating, page_url, user_agent)
             VALUES ($1, $2, $3, $4, $5, $6, $7)`,
            [userId, type, title, message, rating, clean(req.body?.pageUrl, 300) || null, clean(req.get('user-agent'), 300) || null]
        );
        res.json({ success: true });
    } catch (error) {
        console.error('[Feedback] Save error:', error.message);
        res.status(500).json({ error: 'Could not send your feedback. Please try again.' });
    }
});

export { router as feedbackRouter };
