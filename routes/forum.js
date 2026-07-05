const express = require('express');
const router = express.Router();
const ForumPost = require('../models/ForumPost');
const User = require('../models/User');
const { requireAuthUser } = require('../lib/request-auth');

// Middleware to verify authentication
const isAuthenticated = async (req, res, next) => {
  try {
    req.user = await requireAuthUser(req);
    next();
  } catch (error) {
    return res.status(error.statusCode || 401).json({ error: error.message || 'Unauthorized' });
  }
};

// GET all posts
router.get('/posts', async (req, res) => {
  try {
    const posts = await ForumPost.find()
      .populate('authorId', 'firstName lastName role profileImage')
      .populate('courseId', 'title')
      .sort({ isPinned: -1, createdAt: -1 })
      .lean();
    
    // Transform to match frontend interface
    const transformedPosts = posts.map(post => ({
      ...post,
      author: post.authorId,
      replies: post.replies?.length || 0,
    }));
    
    res.json({ posts: transformedPosts });
  } catch (error) {
    console.error('Error fetching forum posts:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// POST create a post
router.post('/posts', isAuthenticated, async (req, res) => {
  try {
    const { title, content, category, courseId, media } = req.body;
    if (!content) {
      return res.status(400).json({ error: 'Content is required' });
    }

    // Generate title from content if not provided
    const postTitle = title || content.substring(0, 100).trim() + (content.length > 100 ? '...' : '');

    const post = new ForumPost({
      title: postTitle,
      content,
      category: category || 'general',
      courseId: courseId || null,
      authorId: req.user.userId,
      media: media || [],
    });

    await post.save();
    await post.populate('authorId', 'firstName lastName role profileImage');
    await post.populate('courseId', 'title');
    
    // Transform to match frontend
    const transformedPost = {
      ...post.toObject(),
      author: post.authorId,
      replies: 0,
    };
    
    res.status(201).json({ post: transformedPost });
  } catch (error) {
    console.error('Error creating post:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET a single post
router.get('/posts/:id', async (req, res) => {
  try {
    const post = await ForumPost.findById(req.params.id)
      .populate('authorId', 'firstName lastName role profileImage')
      .populate('courseId', 'title')
      .populate('replies.authorId', 'firstName lastName role profileImage')
      .lean();
    
    if (!post) {
      return res.status(404).json({ error: 'Post not found' });
    }
    
    // Transform to match frontend
    const transformedPost = {
      ...post,
      author: post.authorId,
      likes: post.likes?.map(id => id.toString()) || [], // Convert ObjectIds to strings
      replies: post.replies?.map(reply => ({
        _id: reply._id.toString(), // Convert reply _id to string
        content: reply.content, // Explicitly include content
        author: reply.authorId,
        likes: reply.likes?.map(id => id.toString()) || [], // Convert reply likes too
        createdAt: reply.createdAt, // Ensure createdAt is included
      })) || [],
    };
    
    // Increment views
    await ForumPost.findByIdAndUpdate(req.params.id, { $inc: { views: 1 } });
    
    res.json({ post: transformedPost });
  } catch (error) {
    console.error('Error fetching post:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// POST like a post
router.post('/posts/:id/like', isAuthenticated, async (req, res) => {
  try {
    const post = await ForumPost.findById(req.params.id);
    if (!post) {
      return res.status(404).json({ error: 'Post not found' });
    }

    const userId = req.user.userId;
    const likeIndex = post.likes.indexOf(userId);

    if (likeIndex > -1) {
      post.likes.splice(likeIndex, 1);
    } else {
      post.likes.push(userId);
    }

    await post.save();
    await post.populate('authorId', 'firstName lastName role profileImage');
    await post.populate('courseId', 'title');
    await post.populate('replies.authorId', 'firstName lastName role profileImage');
    
    // Transform to match frontend
    const transformedPost = {
      ...post.toObject(),
      author: post.authorId,
      likes: post.likes.map(id => id.toString()), // Convert ObjectIds to strings
      replies: post.replies?.map(reply => ({
        _id: reply._id.toString(), // Convert reply _id to string
        content: reply.content, // Explicitly include content
        author: reply.authorId,
        likes: reply.likes?.map(id => id.toString()) || [], // Convert reply likes too
        createdAt: reply.createdAt, // Ensure createdAt is included
      })) || [],
    };
    
    res.json({ post: transformedPost });
  } catch (error) {
    console.error('Error liking post:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// POST reply to a post
router.post('/posts/:id/replies', isAuthenticated, async (req, res) => {
  try {
    const { content } = req.body;
    if (!content) {
      return res.status(400).json({ error: 'Reply content is required' });
    }

    const post = await ForumPost.findById(req.params.id);
    if (!post) {
      return res.status(404).json({ error: 'Post not found' });
    }

    post.replies.push({
      authorId: req.user.userId,
      content,
    });

    await post.save();
    await post.populate('authorId', 'firstName lastName role profileImage');
    await post.populate('courseId', 'title');
    await post.populate('replies.authorId', 'firstName lastName role profileImage');
    
    // Transform to match frontend
    const transformedPost = {
      ...post.toObject(),
      author: post.authorId,
      likes: post.likes.map(id => id.toString()), // Convert ObjectIds to strings
      replies: post.replies?.map(reply => ({
        _id: reply._id.toString(), // Convert reply _id to string
        content: reply.content, // Explicitly include content
        author: reply.authorId,
        likes: reply.likes?.map(id => id.toString()) || [], // Convert reply likes too
        createdAt: reply.createdAt, // Ensure createdAt is included
      })) || [],
    };
    
    res.status(201).json({ post: transformedPost });
  } catch (error) {
    console.error('Error creating reply:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// POST like a reply
router.post('/posts/:id/replies/:replyId/like', isAuthenticated, async (req, res) => {
  try {
    const post = await ForumPost.findById(req.params.id);
    if (!post) {
      return res.status(404).json({ error: 'Post not found' });
    }

    const reply = post.replies.id(req.params.replyId);
    if (!reply) {
      return res.status(404).json({ error: 'Reply not found' });
    }

    const userId = req.user.userId;
    const likeIndex = reply.likes.indexOf(userId);

    if (likeIndex > -1) {
      reply.likes.splice(likeIndex, 1);
    } else {
      reply.likes.push(userId);
    }

    await post.save();
    await post.populate('authorId', 'firstName lastName role profileImage');
    await post.populate('courseId', 'title');
    await post.populate('replies.authorId', 'firstName lastName role profileImage');
    
    // Transform to match frontend
    const transformedPost = {
      ...post.toObject(),
      author: post.authorId,
      likes: post.likes.map(id => id.toString()), // Convert ObjectIds to strings
      replies: post.replies?.map(reply => ({
        _id: reply._id.toString(), // Convert reply _id to string
        content: reply.content, // Explicitly include content
        author: reply.authorId,
        likes: reply.likes?.map(id => id.toString()) || [], // Convert reply likes too
        createdAt: reply.createdAt, // Ensure createdAt is included
      })) || [],
    };
    
    res.json({ post: transformedPost });
  } catch (error) {
    console.error('Error liking reply:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// PUT update a post
router.put('/posts/:id', isAuthenticated, async (req, res) => {
  try {
    const post = await ForumPost.findById(req.params.id);
    if (!post) {
      return res.status(404).json({ error: 'Post not found' });
    }

    // Check if user is the author
    if (post.authorId.toString() !== req.user.userId) {
      return res.status(403).json({ error: 'Unauthorized to edit this post' });
    }

    const { content, category, media } = req.body;
    if (!content) {
      return res.status(400).json({ error: 'Content is required' });
    }

    // Generate title from content if not provided
    const postTitle = content.substring(0, 100).trim() + (content.length > 100 ? '...' : '');

    post.title = postTitle;
    post.content = content;
    if (category) post.category = category;
    
    // Replace media completely with the new array sent from frontend
    // Frontend sends existing media (not deleted) + new media
    if (media !== undefined) {
      post.media = media;
    }

    await post.save();
    await post.populate('authorId', 'firstName lastName role profileImage');
    await post.populate('courseId', 'title');

    const transformedPost = {
      ...post.toObject(),
      author: post.authorId,
      replies: post.replies?.length || 0,
    };

    res.json({ post: transformedPost });
  } catch (error) {
    console.error('Error updating post:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// DELETE a post
router.delete('/posts/:id', isAuthenticated, async (req, res) => {
  try {
    const post = await ForumPost.findById(req.params.id);
    if (!post) {
      return res.status(404).json({ error: 'Post not found' });
    }

    // Check if user is the author
    if (post.authorId.toString() !== req.user.userId) {
      return res.status(403).json({ error: 'Unauthorized to delete this post' });
    }

    await ForumPost.findByIdAndDelete(req.params.id);
    res.json({ message: 'Post deleted successfully' });
  } catch (error) {
    console.error('Error deleting post:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// DELETE a reply
router.delete('/posts/:id/replies/:replyId', isAuthenticated, async (req, res) => {
  try {
    const post = await ForumPost.findById(req.params.id);
    if (!post) {
      return res.status(404).json({ error: 'Post not found' });
    }

    const reply = post.replies.id(req.params.replyId);
    if (!reply) {
      return res.status(404).json({ error: 'Reply not found' });
    }

    // Check if user is the author of the reply
    if (reply.authorId.toString() !== req.user.userId) {
      return res.status(403).json({ error: 'Unauthorized to delete this reply' });
    }

    reply.remove();
    await post.save();
    
    res.json({ message: 'Reply deleted successfully' });
  } catch (error) {
    console.error('Error deleting reply:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

module.exports = router;
