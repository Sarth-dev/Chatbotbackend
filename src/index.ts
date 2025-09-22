import express, { Request, Response } from 'express';
import cors from 'cors';
import { PrismaClient } from '@prisma/client';
import { CohereClient } from 'cohere-ai';

const app = express();
const prisma = new PrismaClient();

// cohere client – will use the key from env
const cohere = new CohereClient({
  token: process.env.COHERE_API_KEY || ''
});

app.use(cors()); 
app.use(express.json()); 

// quick helper – turn any string param into a number safely
function toNumberId(value: unknown): number | null {
  const n = Number(value);
  return Number.isFinite(n) ? Math.floor(n) : null;
}

// get messages for a given user 
app.get('/messages/:userId', async (req: Request, res: Response) => {
  try {
    const userId = toNumberId(req.params.userId);
    if (userId === null) return res.status(400).json({ error: 'bad userId' });

    const page = Number(req.query.page) || 0;
    const limit = Number(req.query.limit) || 10;
    const sessionId = req.query.sessionId ? toNumberId(req.query.sessionId) : null;

    if (req.query.sessionId && sessionId === null) {
      return res.status(400).json({ error: 'bad sessionId' });
    }

    // build a filter for prisma
    const where: any = { userId };
    if (sessionId !== null) where.sessionId = sessionId;

    const [messages, total] = await Promise.all([
      prisma.message.findMany({
        where,
        orderBy: { createdAt: 'asc' },
        skip: page * limit,
        take: limit,
      }),
      prisma.message.count({ where }),
    ]);

    res.json({ messages, total });
  } catch (err) {
    console.error('error fetching messages', err);
    res.status(500).json({ error: (err as Error).message });
  }
});

// save a user message and immediately get an AI reply from cohere
app.post('/messages', async (req, res) => {
  try {
    const { text, userId, sessionId } = req.body;
    if (!text || !userId || !sessionId) {
      return res.status(400).json({ error: 'need text, userId and sessionId' });
    }

    // first store the user’s message
    const userMessage = await prisma.message.create({
      data: {
        text,
        sender: 'user',
        user: { connect: { id: userId } },
        session: { connect: { id: sessionId } },
      },
    });

    // call Cohere to generate a reply
    const response = await cohere.chat({
      model: 'command-r7b-12-2024',
      message: text,
    });

    // trim to be safe
    const aiText = response.text.trim();

    // store the AI/counselor reply as another message
    const counselorMessage = await prisma.message.create({
      data: {
        text: aiText,
        sender: 'counselor',
        user: { connect: { id: userId } },
        session: { connect: { id: sessionId } },
      },
    });

    // return both messages so frontend can update immediately
    res.json([userMessage, counselorMessage]);
  } catch (error) {
    console.error('error saving message', error);
    res.status(500).json({ error: error instanceof Error ? error.message : 'internal error' });
  }
});

// create a new chat session for a user
app.post('/sessions', async (req: Request, res: Response) => {
  try {
    const { userId, title } = req.body;
    const userIdNum = toNumberId(userId);
    if (!title || userIdNum === null) return res.status(400).json({ error: 'need userId and title' });

    const session = await prisma.session.create({
      data: {
        userId: userIdNum,
        title,
      },
    });
    res.json(session);
  } catch (err) {
    console.error('error creating session', err);
    res.status(500).json({ error: (err as Error).message });
  }
});

// list all sessions for a user
app.get('/sessions/:userId', async (req: Request, res: Response) => {
  try {
    const userId = toNumberId(req.params.userId);
    if (userId === null) return res.status(400).json({ error: 'bad userId' });

    const sessions = await prisma.session.findMany({
      where: { userId },
      orderBy: { createdAt: 'asc' },
    });
    res.json(sessions);
  } catch (err) {
    console.error('error fetching sessions', err);
    res.status(500).json({ error: (err as Error).message });
  }
});

// start the server
const PORT = process.env.PORT || 4000;
app.listen(PORT, () => {
  console.log(`backend running on http://localhost:${PORT}`);
});
