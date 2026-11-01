import express from 'express';
import cors from 'cors';
import { promises as fs } from 'fs';
import path from 'path';
import { exec } from 'child_process';
import { promisify } from 'util';
import crypto from 'crypto';

const execPromise = promisify(exec);
const app = express();
const PORT = process.env.PORT || 5000;

const allowedOrigins = [
  'https://autograder-rosy.vercel.app',
  'http://localhost:3000',
  'http://localhost:5173'
];

app.use(cors({
  origin: (origin, callback) => {
    if (!origin || allowedOrigins.includes(origin)) {
      callback(null, true);
    } else {
      callback(new Error('Blocked by CORS'));
    }
  }
}));

app.use(express.json());

// Frontend uses this to determine if the API is "online"
app.get('/health', (req, res) => {
  res.status(200).json({ status: 'online' });
});

app.post('/grade', async (req, res) => {
  const { code, testCases } = req.body;

  if (!code || !Array.isArray(testCases)) {
    return res.status(400).json({ error: 'Code and test cases are required.' });
  }

  const runId = crypto.randomBytes(8).toString('hex');
  const tempDir = path.join('/tmp', `run_${runId}`);

  try {
    await fs.mkdir(tempDir, { recursive: true });
    const sourcePath = path.join(tempDir, 'solution.c');
    const binaryPath = path.join(tempDir, 'solution.out');

    await fs.writeFile(sourcePath, code);

    // Compile with gcc
    try {
      await execPromise(`gcc -O2 -Wall "${sourcePath}" -o "${binaryPath}"`, { timeout: 10000 });
    } catch (compileErr) {
      return res.json({
        status: 'compile_error',
        message: compileErr.stderr || compileErr.message,
        results: []
      });
    }

    const results = [];

    for (const [idx, tc] of testCases.entries()) {
      const input = tc.input ?? '';
      const expected = (tc.expectedOutput ?? '').trim();
      const inputPath = path.join(tempDir, `in_${idx}.txt`);

      await fs.writeFile(inputPath, input);

      try {
        const { stdout } = await execPromise(
          `timeout 2s "${binaryPath}" < "${inputPath}"`,
          { timeout: 3000, maxBuffer: 1024 * 1024 }
        );

        const actual = stdout.trim();
        const passed = actual === expected;

        results.push({
          id: tc.id || idx,
          name: tc.name || `Case ${idx + 1}`,
          passed,
          stdout: actual,
          expected
        });
      } catch (runErr) {
        let status = 'runtime_error';
        if (runErr.killed || runErr.signal === 'SIGTERM') {
          status = 'time_limit_exceeded';
        }

        results.push({
          id: tc.id || idx,
          name: tc.name || `Case ${idx + 1}`,
          passed: false,
          error: status,
          details: runErr.stderr || 'Execution failed or timed out'
        });
      }
    }

    res.json({ status: 'completed', results });
  } catch (err) {
    res.status(500).json({ error: 'Evaluation engine error', details: err.message });
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
  }
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`Autograder backend listening on port ${PORT}`);
});
