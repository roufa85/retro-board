import express from 'express';
import bodyParser from 'body-parser';
import socketIo from 'socket.io';
import socketIoRedisAdapter from 'socket.io-redis';
import redis from 'redis';
import connectRedis from 'connect-redis';
import http from 'http';
import chalk from 'chalk';
import db from './db';
import config from './db/config';
import * as Sentry from '@sentry/node';
import passport from 'passport';
import passportInit from './auth/passport';
import authRouter from './auth/router';
import session from 'express-session';
import game from './game';
import { getUser } from './utils';

const useSentry = !!config.SENTRY_URL && config.SENTRY_URL !== 'NO_SENTRY';

if (useSentry) {
  Sentry.init({
    dsn: config.SENTRY_URL,
  });
  console.log(chalk`{yellow 🐜  Using {red Sentry} for error reporting}`);
}

const app = express();
if (useSentry) {
  app.use(Sentry.Handlers.requestHandler());
}

app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));

// saveUninitialized: true allows us to attach the socket id to the session
// before we have athenticated the user
let sessionMiddleware: express.RequestHandler;

if (config.REDIS_ENABLED) {
  const RedisStore = connectRedis(session);
  const redisClient = redis.createClient({
    host: config.REDIS_HOST,
    port: config.REDIS_PORT,
  });
  sessionMiddleware = session({
    secret: process.env.SESSION_SECRET!,
    resave: true,
    saveUninitialized: true,
    store: new RedisStore({ client: redisClient }),
  });
} else {
  sessionMiddleware = session({
    secret: process.env.SESSION_SECRET!,
    resave: true,
    saveUninitialized: true,
  });
}

app.use(sessionMiddleware);

app.use(passport.initialize());

const httpServer = new http.Server(app);

app.get('/api/ping', (req, res) => {
  console.log('Session: ', req.session);
  console.log('User: ', getUser(req));
  res.send('pong');
});

// Liveliness Probe
app.get('/healthz', async (_, res) => {
  res.status(200).send();
});

app.use('/api/auth', authRouter);

const io = socketIo(httpServer);

io.use(function(socket, next) {
  sessionMiddleware(socket.request, {} as any, next);
});

app.set('io', io);
const port = config.BACKEND_PORT || 8081;

if (config.REDIS_ENABLED) {
  io.adapter(
    socketIoRedisAdapter({ host: config.REDIS_HOST, port: config.REDIS_PORT })
  );
  console.log(chalk`{red Redis} was properly activated`);
}

db().then(store => {
  passportInit(store);
  game(store, io);

  // Create session
  app.post('/api/create/:id', async (req, res) => {
    console.log('Create: ', req.body, req.params.id);
    console.log('User: ', req.user);
    await store.create(req.params.id, req.body.options, req.body.columns);
    res.status(200).send();
  });

  app.post('/api/logout', async (req, res, next) => {
    req.logout();
    req.session?.destroy(err => {
      if (err) {
        return next(err);
      }
      return res.send({ authenticated: req.isAuthenticated() });
    });
  });

  app.get('/api/me', (req, res) => {
    const user = getUser(req);
    if (user) {
      res.status(200).send(user);
    } else {
      res.status(401).send('Not logged in');
    }
  });

  if (useSentry) {
    app.use(Sentry.Handlers.errorHandler());
  }
});

httpServer.listen(port);
const env = process.env.NODE_ENV || 'dev';
console.log(
  chalk`Server started on port {red ${port.toString()}}, environment: {blue ${env}}`
);
