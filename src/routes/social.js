const router = require('express').Router();
const { authenticate, requireRole } = require('../middleware/auth');
const { asyncHandler } = require('../middleware/errorHandler');
const { body, param } = require('express-validator');
const { validate } = require('../middleware/validate');
const { supabaseAdmin } = require('../config/supabase');

router.use(authenticate);

// ── Outfit Feed ────────────────────────────────────────────────────────────

/**
 * GET /api/v1/social/outfit-feed
 * Returns outfit posts for the current shopper's feed.
 *   - Following someone → posts from followed shoppers, newest first
 *   - Nobody followed   → global fallback, highest liked first
 * Returns { posts: [] }
 */
router.get(
  '/outfit-feed',
  requireRole('shopper'),
  asyncHandler(async (req, res) => {
    const userId = req.userId;

    // Who does this user follow / block?
    const [{ data: follows }, { data: blocks }] = await Promise.all([
      supabaseAdmin
        .from('shopper_follows')
        .select('following_id')
        .eq('follower_id', userId),
      supabaseAdmin
        .from('user_blocks')
        .select('blocked_id')
        .eq('blocker_id', userId),
    ]);

    const blockedIds = (blocks || []).map((b) => b.blocked_id);
    const followingIds = (follows || [])
      .map((f) => f.following_id)
      .filter((id) => !blockedIds.includes(id));

    const selectFields = `
      id, image_url, caption, like_count, created_at, shopper_id,
      post_product_tags (
        id, x_percent, y_percent,
        products ( id, name, price, images, boutique_id )
      )
    `;

    let rawPosts;

    if (followingIds.length > 0) {
      let q = supabaseAdmin
        .from('outfit_posts')
        .select(selectFields)
        .in('shopper_id', followingIds)
        .eq('hidden', false)
        .order('created_at', { ascending: false })
        .limit(30);
      const { data, error } = await q;
      if (error) throw new Error(error.message);
      rawPosts = data;
    } else {
      let q = supabaseAdmin
        .from('outfit_posts')
        .select(selectFields)
        .eq('hidden', false)
        .order('like_count', { ascending: false })
        .limit(30);
      if (blockedIds.length > 0) {
        q = q.not('shopper_id', 'in', `(${blockedIds.join(',')})`);
      }
      const { data, error } = await q;
      if (error) throw new Error(error.message);
      rawPosts = data;
    }

    if (!rawPosts || rawPosts.length === 0) {
      return res.json({ posts: [] });
    }

    // Attach poster profile (batch lookup on shoppers table)
    const posterIds = [...new Set(rawPosts.map((p) => p.shopper_id))];
    const { data: shoppers } = await supabaseAdmin
      .from('shoppers')
      .select('user_id, display_name, full_name, avatar_url')
      .in('user_id', posterIds);

    const shopperMap = {};
    for (const s of shoppers || []) {
      shopperMap[s.user_id] = {
        display_name: s.display_name || s.full_name || 'Shopper',
        avatar_url: s.avatar_url || null,
      };
    }

    // Fetch which posts the current user has liked (for is_liked_by_me)
    const postIds = rawPosts.map((p) => p.id);
    const { data: myLikes } = await supabaseAdmin
      .from('post_likes')
      .select('post_id')
      .eq('shopper_id', userId)
      .in('post_id', postIds);

    const likedSet = new Set((myLikes || []).map((l) => l.post_id));

    const posts = rawPosts.map((post) => ({
      ...post,
      poster: shopperMap[post.shopper_id] || { display_name: 'Shopper', avatar_url: null },
      is_liked_by_me: likedSet.has(post.id),
    }));

    res.json({ posts });
  })
);

// ── Shopper public profile ─────────────────────────────────────────────────

/**
 * GET /api/v1/social/shoppers/:id
 * Public shopper profile — avatar, name, follow counts, posts.
 * :id is the auth user_id (UUID).
 */
router.get(
  '/shoppers/:id',
  asyncHandler(async (req, res) => {
    const targetUserId = req.params.id;
    const viewerId = req.userId;

    // Basic shopper info
    const { data: shopper, error: shopperErr } = await supabaseAdmin
      .from('shoppers')
      .select('user_id, display_name, full_name, avatar_url, style_preferences, created_at')
      .eq('user_id', targetUserId)
      .single();

    if (shopperErr || !shopper) {
      return res.status(404).json({ error: 'Shopper not found' });
    }

    // Follower / following counts
    const [followerRes, followingRes, isFollowingRes, postsRes] = await Promise.all([
      supabaseAdmin
        .from('shopper_follows')
        .select('*', { count: 'exact', head: true })
        .eq('following_id', targetUserId),
      supabaseAdmin
        .from('shopper_follows')
        .select('*', { count: 'exact', head: true })
        .eq('follower_id', targetUserId),
      supabaseAdmin
        .from('shopper_follows')
        .select('follower_id')
        .eq('follower_id', viewerId)
        .eq('following_id', targetUserId)
        .maybeSingle(),
      supabaseAdmin
        .from('outfit_posts')
        .select('id, image_url, like_count, created_at')
        .eq('shopper_id', targetUserId)
        .order('created_at', { ascending: false })
        .limit(24),
    ]);

    res.json({
      id: shopper.user_id,
      display_name: shopper.display_name || shopper.full_name || 'Shopper',
      avatar_url: shopper.avatar_url || null,
      style_preferences: shopper.style_preferences || [],
      follower_count: followerRes.count || 0,
      following_count: followingRes.count || 0,
      is_followed_by_me: !!isFollowingRes.data,
      posts: postsRes.data || [],
    });
  })
);

/**
 * POST /api/v1/social/shoppers/:id/follow
 * Follow a shopper. Idempotent.
 */
router.post(
  '/shoppers/:id/follow',
  requireRole('shopper'),
  asyncHandler(async (req, res) => {
    const followerId = req.userId;
    const followingId = req.params.id;

    if (followerId === followingId) {
      return res.status(400).json({ error: 'Cannot follow yourself' });
    }

    const { error } = await supabaseAdmin
      .from('shopper_follows')
      .upsert({ follower_id: followerId, following_id: followingId });

    if (error) throw new Error(error.message);
    res.json({ followed: true });
  })
);

/**
 * DELETE /api/v1/social/shoppers/:id/follow
 * Unfollow a shopper.
 */
router.delete(
  '/shoppers/:id/follow',
  requireRole('shopper'),
  asyncHandler(async (req, res) => {
    const followerId = req.userId;
    const followingId = req.params.id;

    const { error } = await supabaseAdmin
      .from('shopper_follows')
      .delete()
      .eq('follower_id', followerId)
      .eq('following_id', followingId);

    if (error) throw new Error(error.message);
    res.json({ followed: false });
  })
);

// ── Outfit posts ───────────────────────────────────────────────────────────

/**
 * POST /api/v1/social/posts
 * Create an outfit post + optional product-tag dots.
 * Body: { image_url, caption?, tags?: [{product_id, x_percent, y_percent}] }
 */
router.post(
  '/posts',
  requireRole('shopper'),
  [
    body('image_url').isURL().withMessage('image_url must be a valid URL'),
    body('caption').optional().isString().trim(),
    body('tags').optional().isArray().withMessage('tags must be an array'),
    body('tags.*.product_id').isUUID(),
    body('tags.*.x_percent').isFloat({ min: 0, max: 100 }),
    body('tags.*.y_percent').isFloat({ min: 0, max: 100 }),
    validate,
  ],
  asyncHandler(async (req, res) => {
    const { image_url, caption, tags = [] } = req.body;
    const shopperId = req.userId;

    // Insert post
    const { data: post, error: postErr } = await supabaseAdmin
      .from('outfit_posts')
      .insert({ shopper_id: shopperId, image_url, caption: caption || null })
      .select()
      .single();

    if (postErr) throw new Error(postErr.message);

    // Insert product tags (max 5)
    if (tags.length > 0) {
      const tagRows = tags.slice(0, 5).map((t) => ({
        post_id: post.id,
        product_id: t.product_id,
        x_percent: t.x_percent,
        y_percent: t.y_percent,
      }));

      const { error: tagsErr } = await supabaseAdmin
        .from('post_product_tags')
        .insert(tagRows);

      if (tagsErr) throw new Error(tagsErr.message);
    }

    res.status(201).json(post);
  })
);

/**
 * GET /api/v1/social/posts/:id
 * Get a single outfit post with product-tag dots, poster info, and like state.
 */
router.get(
  '/posts/:id',
  asyncHandler(async (req, res) => {
    const { id } = req.params;
    const viewerId = req.userId;

    const { data: post, error } = await supabaseAdmin
      .from('outfit_posts')
      .select(`
        id, image_url, caption, like_count, created_at, shopper_id,
        post_product_tags (
          id, x_percent, y_percent,
          products (
            id, name, price, images, boutique_id,
            boutiques ( name )
          )
        )
      `)
      .eq('id', id)
      .single();

    if (error || !post) return res.status(404).json({ error: 'Post not found' });

    // Poster info
    const { data: poster } = await supabaseAdmin
      .from('shoppers')
      .select('display_name, full_name, avatar_url')
      .eq('user_id', post.shopper_id)
      .single();

    // Like state for current viewer
    const { data: likeRow } = await supabaseAdmin
      .from('post_likes')
      .select('shopper_id')
      .eq('shopper_id', viewerId)
      .eq('post_id', id)
      .maybeSingle();

    res.json({
      ...post,
      poster: poster
        ? {
            display_name: poster.display_name || poster.full_name || 'Shopper',
            avatar_url: poster.avatar_url || null,
          }
        : { display_name: 'Shopper', avatar_url: null },
      is_liked_by_me: !!likeRow,
    });
  })
);

/**
 * POST /api/v1/social/posts/:id/like
 * Like a post (idempotent). Increments like_count.
 */
router.post(
  '/posts/:id/like',
  requireRole('shopper'),
  asyncHandler(async (req, res) => {
    const postId = req.params.id;
    const shopperId = req.userId;

    // Upsert the like row
    const { error: likeErr } = await supabaseAdmin
      .from('post_likes')
      .upsert({ shopper_id: shopperId, post_id: postId });

    if (likeErr) throw new Error(likeErr.message);

    // Recount from post_likes for accuracy
    const { count } = await supabaseAdmin
      .from('post_likes')
      .select('*', { count: 'exact', head: true })
      .eq('post_id', postId);

    await supabaseAdmin
      .from('outfit_posts')
      .update({ like_count: count || 0 })
      .eq('id', postId);

    res.json({ liked: true, like_count: count || 0 });
  })
);

/**
 * DELETE /api/v1/social/posts/:id/like
 * Unlike a post. Decrements like_count.
 */
router.delete(
  '/posts/:id/like',
  requireRole('shopper'),
  asyncHandler(async (req, res) => {
    const postId = req.params.id;
    const shopperId = req.userId;

    const { error: delErr } = await supabaseAdmin
      .from('post_likes')
      .delete()
      .eq('shopper_id', shopperId)
      .eq('post_id', postId);

    if (delErr) throw new Error(delErr.message);

    // Recount for accuracy
    const { count } = await supabaseAdmin
      .from('post_likes')
      .select('*', { count: 'exact', head: true })
      .eq('post_id', postId);

    await supabaseAdmin
      .from('outfit_posts')
      .update({ like_count: count || 0 })
      .eq('id', postId);

    res.json({ liked: false, like_count: count || 0 });
  })
);

/**
 * DELETE /api/v1/social/posts/:id
 * Delete an outfit post. Only the post owner may delete it.
 * Also cleans up post_product_tags and post_likes.
 */
router.delete(
  '/posts/:id',
  requireRole('shopper'),
  asyncHandler(async (req, res) => {
    const postId = req.params.id;
    const shopperId = req.userId;

    // Verify ownership
    const { data: post } = await supabaseAdmin
      .from('outfit_posts')
      .select('shopper_id')
      .eq('id', postId)
      .single();

    if (!post) return res.status(404).json({ error: 'Post not found' });
    if (post.shopper_id !== shopperId) {
      return res.status(403).json({ error: 'Forbidden — you can only delete your own posts' });
    }

    // Delete child rows first (FK constraints)
    await supabaseAdmin.from('post_product_tags').delete().eq('post_id', postId);
    await supabaseAdmin.from('post_likes').delete().eq('post_id', postId);
    const { error: delErr } = await supabaseAdmin
      .from('outfit_posts')
      .delete()
      .eq('id', postId);

    if (delErr) throw new Error(delErr.message);
    res.json({ deleted: true });
  })
);

// ── Moderation (App Store UGC requirements) ─────────────────────────────────

/**
 * POST /api/v1/social/posts/:id/report
 * Report a post. Idempotent per reporter. After 3 distinct reports the
 * post is auto-hidden pending admin review.
 * Body: { reason: inappropriate|spam|offensive|stolen_content|other, notes? }
 */
router.post(
  '/posts/:id/report',
  requireRole('shopper'),
  [
    body('reason').isIn(['inappropriate', 'spam', 'offensive', 'stolen_content', 'other']),
    body('notes').optional().isString().isLength({ max: 500 }),
    validate,
  ],
  asyncHandler(async (req, res) => {
    const postId = req.params.id;

    const { data: post } = await supabaseAdmin
      .from('outfit_posts')
      .select('id')
      .eq('id', postId)
      .single();
    if (!post) return res.status(404).json({ error: 'Post not found' });

    const { error } = await supabaseAdmin
      .from('post_reports')
      .upsert({
        post_id:     postId,
        reporter_id: req.userId,
        reason:      req.body.reason,
        notes:       req.body.notes || null,
      }, { onConflict: 'post_id,reporter_id' });

    if (error) throw new Error(error.message);

    // Auto-hide after 3 distinct reporters — fail-safe for live UGC
    const { count } = await supabaseAdmin
      .from('post_reports')
      .select('id', { count: 'exact', head: true })
      .eq('post_id', postId);

    if ((count || 0) >= 3) {
      await supabaseAdmin
        .from('outfit_posts')
        .update({ hidden: true })
        .eq('id', postId);
    }

    res.json({ reported: true });
  })
);

/**
 * POST /api/v1/social/users/:id/block
 * Block a user — their posts disappear from your feeds.
 */
router.post(
  '/users/:id/block',
  requireRole('shopper'),
  [param('id').isUUID().withMessage('id must be a UUID'), validate],
  asyncHandler(async (req, res) => {
    const blockedId = req.params.id;
    if (blockedId === req.userId) {
      return res.status(400).json({ error: 'Cannot block yourself' });
    }

    const { error } = await supabaseAdmin
      .from('user_blocks')
      .upsert({ blocker_id: req.userId, blocked_id: blockedId });

    if (error) throw new Error(error.message);

    // Blocking also severs the follow relationship both ways
    await supabaseAdmin
      .from('shopper_follows')
      .delete()
      .or(`and(follower_id.eq.${req.userId},following_id.eq.${blockedId}),and(follower_id.eq.${blockedId},following_id.eq.${req.userId})`);

    res.json({ blocked: true });
  })
);

/**
 * DELETE /api/v1/social/users/:id/block
 * Unblock a user.
 */
router.delete(
  '/users/:id/block',
  requireRole('shopper'),
  [param('id').isUUID().withMessage('id must be a UUID'), validate],
  asyncHandler(async (req, res) => {
    const { error } = await supabaseAdmin
      .from('user_blocks')
      .delete()
      .eq('blocker_id', req.userId)
      .eq('blocked_id', req.params.id);

    if (error) throw new Error(error.message);
    res.json({ blocked: false });
  })
);

module.exports = router;
