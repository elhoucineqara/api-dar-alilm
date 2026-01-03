const express = require('express');
const router = express.Router();
const Certificate = require('../models/Certificate');

// GET certificate by ID (public route for sharing)
router.get('/:id', async (req, res) => {
  try {
    const { id } = req.params;

    const certificate = await Certificate.findById(id).lean();
    
    if (!certificate) {
      return res.status(404).json({ error: 'Certificate not found' });
    }

    res.json({ 
      certificate: {
        _id: certificate._id,
        certificateId: certificate.certificateId,
        studentName: certificate.studentName,
        courseName: certificate.courseName,
        instructorName: certificate.instructorName,
        score: certificate.score,
        completionDate: certificate.completionDate,
        issuedAt: certificate.issuedAt,
      }
    });
  } catch (error) {
    console.error('Error fetching certificate:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

module.exports = router;

