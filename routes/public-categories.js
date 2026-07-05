const express = require('express');

const { ensureDefaultCategories } = require('../lib/category-catalog');

const router = express.Router();

router.get('/', async (req, res) => {
  try {
    const categories = await ensureDefaultCategories();
    return res.json({ categories });
  } catch (error) {
    console.error('Error fetching public categories:', error);
    return res.status(500).json({
      error: 'Internal server error',
    });
  }
});

module.exports = router;
