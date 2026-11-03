const request = require('supertest');
const app = require('../../index');
const User = require('../../src/models/User');
const { invalidateUserCache } = require('../../src/middleware/auth');

describe('Auth API Routes (/api/auth)', () => {
  let user;

  beforeEach(async () => {
    invalidateUserCache();
    user = await User.create({
      name: 'Rohan Sharma',
      phone: '9876543210',
      password: 'password123',
      role: 'student',
      isActive: true,
      tokenVersion: 0
    });
  });

  describe('POST /api/auth/login', () => {
    it('returns 400 when phone or password is missing or malformed', async () => {
      const res = await request(app)
        .post('/api/auth/login')
        .send({ phone: '123' }); // invalid phone format & missing password

      expect(res.statusCode).toBe(400);
      expect(res.body.success).toBe(false);
      expect(res.body.errors).toBeDefined();
    });

    it('returns 401 for non-existent phone number', async () => {
      const res = await request(app)
        .post('/api/auth/login')
        .send({ phone: '9999999999', password: 'password123' });

      expect(res.statusCode).toBe(401);
      expect(res.body.success).toBe(false);
      expect(res.body.message).toMatch(/Invalid phone number or password/i);
    });

    it('returns 401 for incorrect password', async () => {
      const res = await request(app)
        .post('/api/auth/login')
        .send({ phone: '9876543210', password: 'wrongpassword' });

      expect(res.statusCode).toBe(401);
      expect(res.body.success).toBe(false);
    });

    it('returns 200 and JWT token on successful credentials', async () => {
      const res = await request(app)
        .post('/api/auth/login')
        .send({ phone: '9876543210', password: 'password123' });

      expect(res.statusCode).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.token).toBeDefined();
      expect(res.body.user).toBeDefined();
      expect(res.body.user.name).toBe('Rohan Sharma');
      expect(res.body.user.role).toBe('student');
    });

    it('returns 403 when user account is deactivated', async () => {
      user.isActive = false;
      await user.save();

      const res = await request(app)
        .post('/api/auth/login')
        .send({ phone: '9876543210', password: 'password123' });

      expect(res.statusCode).toBe(403);
      expect(res.body.success).toBe(false);
      expect(res.body.message).toMatch(/Account is inactive/i);
    });
  });

  describe('GET /api/auth/me', () => {
    it('returns 401 without Bearer token', async () => {
      const res = await request(app)
        .get('/api/auth/me');

      expect(res.statusCode).toBe(401);
    });

    it('returns user profile with valid token', async () => {
      // First login to obtain token
      const loginRes = await request(app)
        .post('/api/auth/login')
        .send({ phone: '9876543210', password: 'password123' });

      const token = loginRes.body.token;

      const res = await request(app)
        .get('/api/auth/me')
        .set('Authorization', `Bearer ${token}`);

      expect(res.statusCode).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.user.phone).toBe('9876543210');
      expect(res.body.user.name).toBe('Rohan Sharma');
    });
  });
});

