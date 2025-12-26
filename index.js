const express = require('express');
const cors = require('cors');
const dotenv = require('dotenv');
const connectDB = require('./lib/db');

// Load environment variables
dotenv.config();

const app = express();
const PORT = process.env.PORT || 5000;

// CORS configuration - Handle preflight requests BEFORE any redirects
const corsOptions = {
  origin: function (origin, callback) {
    // Allow requests with no origin (like mobile apps or curl requests)
    if (!origin) return callback(null, true);
    // Allow all origins in production, or specific origins in development
    callback(null, true);
  },
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With', 'Accept', 'Origin'],
  exposedHeaders: ['Content-Type', 'Content-Disposition', 'Content-Length'],
  preflightContinue: false,
  optionsSuccessStatus: 204
};

// Handle OPTIONS requests explicitly BEFORE CORS middleware to prevent redirects
app.use((req, res, next) => {
  if (req.method === 'OPTIONS') {
    res.header('Access-Control-Allow-Origin', req.headers.origin || '*');
    res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, PATCH, OPTIONS');
    res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Requested-With, Accept, Origin');
    res.header('Access-Control-Allow-Credentials', 'true');
    res.header('Access-Control-Max-Age', '86400');
    return res.status(204).end();
  }
  next();
});

// Apply CORS middleware
app.use(cors(corsOptions));

// Skip body parsing for upload routes - let multer handle it
app.use((req, res, next) => {
  if (req.path.includes('/upload')) {
    // Skip body parsing for upload routes
    return next();
  }
  // Apply body parsers for other routes
  express.json({ limit: '50mb', type: 'application/json' })(req, res, next);
});

app.use((req, res, next) => {
  if (req.path.includes('/upload')) {
    return next();
  }
  express.urlencoded({ limit: '50mb', extended: true })(req, res, next);
});

// Routes
const authRoutes = require('./routes/auth');
const courseRoutes = require('./routes/courses');
const publicCoursesRoutes = require('./routes/public-courses');
const instructorRoutes = require('./routes/instructor');
const studentRoutes = require('./routes/student');
const forumRoutes = require('./routes/forum');
const moduleRoutes = require('./routes/modules');
const uploadRoutes = require('./routes/upload');
const sectionRoutes = require('./routes/sections');
const quizRoutes = require('./routes/quizzes');
const filesRoutes = require('./routes/files');

app.use('/api/auth', authRoutes);
app.use('/api/courses', publicCoursesRoutes); // Public courses route (no auth required)
app.use('/api/instructor/courses', courseRoutes);
app.use('/api/instructor/modules', moduleRoutes);
app.use('/api/instructor/sections', sectionRoutes);
app.use('/api/instructor/quizzes', quizRoutes);
app.use('/api/instructor/upload', uploadRoutes);
app.use('/api/instructor', instructorRoutes);
app.use('/api/student', studentRoutes);
app.use('/api/forum', forumRoutes);
app.use('/api/files', filesRoutes); // Public files route (no auth required)

// Basic route
app.get('/', (req, res) => {
  res.send('LMS API is running...');
});

// Start server after connecting to database
async function startServer() {
  try {
    // Connect to Database first
    await connectDB();
    console.log('MongoDB connected successfully');
    
    // Then start the server
    app.listen(PORT, () => {
      console.log(`Server is running on port ${PORT}`);
    });
  } catch (error) {
    console.error('Failed to connect to MongoDB:', error);
    process.exit(1);
  }
}

startServer();
