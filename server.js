import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';
import { GoogleGenAI } from '@google/genai';

dotenv.config();
dotenv.config({ path: '.env.local' });

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Initialize Gemini AI Client (cached singleton)
let geminiClient = null;
function getGeminiClient() {
  const apiKey = process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY;
  if (!apiKey) return null;
  if (!geminiClient) {
    geminiClient = new GoogleGenAI({ apiKey });
  }
  return geminiClient;
}

// Generate 1536-dimensional embeddings using gemini-embedding-001 (matches existing database vector column)
async function generateEmbeddings(texts) {
  const ai = getGeminiClient();
  if (!ai) throw new Error('GEMINI_API_KEY or GOOGLE_API_KEY is not configured on the server.');
  if (!texts || texts.length === 0) return [];

  const BATCH_SIZE = 50;
  const allEmbeddings = [];

  for (let i = 0; i < texts.length; i += BATCH_SIZE) {
    const batch = texts.slice(i, i + BATCH_SIZE);
    const response = await ai.models.embedContent({
      model: 'gemini-embedding-001',
      contents: batch,
      config: { outputDimensionality: 1536 }
    });

    if (response.embeddings && response.embeddings.length > 0) {
      allEmbeddings.push(...response.embeddings.map(e => e.values));
    } else if (response.embedding && response.embedding.values) {
      allEmbeddings.push(response.embedding.values);
    } else {
      throw new Error('No embeddings returned by Gemini API.');
    }
  }

  return allEmbeddings;
}

const app = express();
const port = process.env.PORT || 3000;
const host = process.env.HOST || '0.0.0.0';

app.use(cors());
app.use(express.json());

// Serve the static vanilla frontend
app.use(express.static(path.join(__dirname, 'public')));

import multer from 'multer';

// Lightweight health check endpoints for hosting platforms (Render, uptime monitors)
app.get('/health', (req, res) => {
  res.status(200).json({ status: 'ok', service: 'vaultai' });
});

app.get('/api/health', (req, res) => {
  res.status(200).json({ status: 'ok', service: 'vaultai' });
});

// Dedicated server-side Gemini connection test endpoint
app.post('/api/ai-test', async (req, res) => {
  try {
    const { prompt } = req.body || {};
    if (!prompt || typeof prompt !== 'string' || prompt.trim().length === 0) {
      return res.status(400).json({ error: 'Prompt is required and must be a non-empty string.' });
    }

    const ai = getGeminiClient();
    if (!ai) {
      return res.status(500).json({ error: 'Gemini API key is not configured on the server. Check GEMINI_API_KEY in .env.local.' });
    }

    const modelName = process.env.GEMINI_MODEL || 'gemini-3.8-flash';

    const response = await ai.models.generateContent({
      model: modelName,
      contents: prompt.trim()
    });

    const text = response.text?.trim() || '';

    res.json({
      success: true,
      model: modelName,
      text: text
    });
  } catch (err) {
    console.error('AI test endpoint error:', err.message);
    const status = err.status || (err.message && err.message.includes('429') ? 429 : 500);
    res.status(status).json({
      error: err.message || 'Failed to generate text from Gemini API.',
      status
    });
  }
});

// Configure multer for memory storage (10 MB limit)
const upload = multer({ 
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 } 
});

// Create a helper to initialize Supabase
import { createClient } from '@supabase/supabase-js';

// Secure Document Upload Endpoint
app.post('/api/documents/upload', upload.single('file'), async (req, res) => {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader) return res.status(401).json({ error: 'Missing Authorization header' });
    const token = authHeader.replace('Bearer ', '');

    // Initialize authenticated Supabase client for this request (on behalf of the user)
    const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY, {
      global: { headers: { Authorization: `Bearer ${token}` } }
    });

    // Verify token and get user
    const { data: { user }, error: authError } = await supabase.auth.getUser();
    if (authError || !user) return res.status(401).json({ error: 'Invalid token' });

    // Validate file
    const file = req.file;
    if (!file) return res.status(400).json({ error: 'No file provided' });
    
    // Check file extension (only PDF initially)
    const ext = path.extname(file.originalname).toLowerCase();
    if (ext !== '.pdf') {
      return res.status(400).json({ error: 'Unsupported file type. Only PDF is allowed for MVP.' });
    }

    // Resolve workspace membership securely on the server
    const { data: memberships, error: membershipError } = await supabase
      .from('tenant_memberships')
      .select('tenant_id, role')
      .eq('user_id', user.id);

    if (membershipError || !memberships || memberships.length === 0) {
      return res.status(403).json({ error: 'User does not belong to any workspace' });
    }

    // For MVP, just use the user's first authorized tenant. 
    // Do not trust an arbitrary tenant_id from the browser.
    const targetTenantId = memberships[0].tenant_id;

    // Upload to Storage privately
    const safeFilename = `${Date.now()}-${file.originalname.replace(/[^a-zA-Z0-9.\-_]/g, '_')}`;
    const storagePath = `${targetTenantId}/${safeFilename}`;

    const { data: storageData, error: storageError } = await supabase.storage
      .from('enterprisedocumentstorage')
      .upload(storagePath, file.buffer, {
        contentType: file.mimetype,
        upsert: false
      });

    if (storageError) {
      console.error("Storage upload error:", storageError);
      return res.status(500).json({ error: 'Failed to upload document to storage.' });
    }

    // Insert into database using verified columns
    const { data: docData, error: dbError } = await supabase
      .from('documents')
      .insert({
        tenant_id: targetTenantId,
        file_name: file.originalname,
        storage_path: storagePath,
        status: 'uploaded'
      })
      .select()
      .single();

    if (dbError) {
      console.error("Database insert error:", {
        code: dbError.code,
        message: dbError.message,
        details: dbError.details,
        hint: dbError.hint,
        targetTenantId: targetTenantId
      });
      // Cleanup storage if DB insertion fails to prevent orphaned files
      await supabase.storage.from('enterprisedocumentstorage').remove([storagePath]);
      return res.status(500).json({ error: 'Upload succeeded but database registration failed. Please contact support or check workspace permissions.' });
    }

    // Automatically run extraction, chunking, and embedding pipeline immediately upon upload
    let processResult = null;
    try {
      processResult = await processDocumentPipeline(supabase, docData, file.buffer);
    } catch (procErr) {
      console.error("Document auto-processing error during upload:", procErr.message);
      await supabase.from('documents').update({ status: 'error' }).eq('id', docData.id);
      return res.status(500).json({ 
        error: `File uploaded to storage, but automatic processing failed: ${procErr.message}`,
        document: docData
      });
    }

    res.json({ 
      success: true, 
      document: { ...docData, status: processResult.status },
      chunksCreated: processResult.totalChunks,
      textLength: processResult.textLength,
      message: processResult.message
    });

  } catch (err) {
    console.error('Upload error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// PDF Extraction & Processing Endpoint
app.post('/api/documents/:id/extract', async (req, res) => {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader) return res.status(401).json({ error: 'Missing Authorization header' });
    const token = authHeader.replace('Bearer ', '');

    const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY, {
      global: { headers: { Authorization: `Bearer ${token}` } }
    });

    const { data: { user }, error: authError } = await supabase.auth.getUser();
    if (authError || !user) return res.status(401).json({ error: 'Invalid token' });

    const { data: docData, error: dbError } = await supabase
      .from('documents')
      .select('*')
      .eq('id', req.params.id)
      .single();

    if (dbError || !docData) {
      return res.status(404).json({ error: 'Document not found or access denied.' });
    }

    const processResult = await processDocumentPipeline(supabase, docData);
    res.json(processResult);
  } catch (err) {
    console.error('Extract endpoint error:', err);
    res.status(500).json({ error: err.message || 'Internal server error during extraction.' });
  }
});

// Authenticated Endpoint to retrieve extracted text for a workspace document
app.get('/api/documents/:id/text', async (req, res) => {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader) return res.status(401).json({ error: 'Missing Authorization header' });
    const token = authHeader.replace('Bearer ', '');

    const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY, {
      global: { headers: { Authorization: `Bearer ${token}` } }
    });

    const { data: { user }, error: authError } = await supabase.auth.getUser();
    if (authError || !user) return res.status(401).json({ error: 'Invalid token' });

    // Fetch document verifying tenant membership via RLS
    const { data: docData, error: dbError } = await supabase
      .from('documents')
      .select('id, tenant_id, file_name, status, content, created_at')
      .eq('id', req.params.id)
      .single();

    if (dbError || !docData) {
      return res.status(404).json({ error: 'Document not found or access denied.' });
    }

    res.json({
      id: docData.id,
      fileName: docData.file_name,
      status: docData.status,
      textLength: docData.content ? docData.content.length : 0,
      content: docData.content || ''
    });
  } catch (err) {
    console.error('Fetch document text error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Document Text Chunking Helper (semantic boundary-aware with sliding window overlap)
function chunkText(text, options = {}) {
  const chunkSize = options.chunkSize || 1000;
  const chunkOverlap = options.chunkOverlap || 150;

  if (!text || typeof text !== 'string') return [];
  const rawText = text.replace(/\r\n/g, '\n').trim();
  if (!rawText) return [];

  // If text is within one chunk size, return single chunk
  if (rawText.length <= chunkSize) {
    return [{ chunk_index: 0, content: rawText }];
  }

  const chunks = [];
  let startIndex = 0;

  while (startIndex < rawText.length) {
    let endIndex = startIndex + chunkSize;

    if (endIndex >= rawText.length) {
      endIndex = rawText.length;
    } else {
      // Find natural boundary near endIndex within a reasonable window
      const windowStart = Math.max(startIndex, endIndex - 150);
      const windowEnd = Math.min(rawText.length, endIndex + 50);
      const searchWindow = rawText.substring(windowStart, windowEnd);

      let breakOffset = searchWindow.lastIndexOf('\n\n');
      if (breakOffset === -1) breakOffset = searchWindow.lastIndexOf('\n');
      if (breakOffset === -1) {
        const periodOffset = searchWindow.lastIndexOf('. ');
        if (periodOffset !== -1) breakOffset = periodOffset + 1; // include period
      }
      if (breakOffset === -1) breakOffset = searchWindow.lastIndexOf(' ');

      if (breakOffset !== -1) {
        const potentialEnd = windowStart + breakOffset;
        if (potentialEnd > startIndex + Math.floor(chunkSize * 0.4)) {
          endIndex = potentialEnd;
        }
      }
    }

    const chunkContent = rawText.substring(startIndex, endIndex).trim();
    if (chunkContent.length > 0) {
      chunks.push({
        chunk_index: chunks.length,
        content: chunkContent
      });
    }

    if (endIndex >= rawText.length) break;

    // Advance startIndex with overlap, ensuring strictly positive progress
    const nextStart = endIndex - chunkOverlap;
    startIndex = nextStart > startIndex ? nextStart : endIndex;
  }

  return chunks;
}

// Unified end-to-end processing pipeline: Extract -> Chunk -> Embed -> Store Chunks
async function processDocumentPipeline(supabase, docData, fileBuffer = null) {
  let currentDoc = docData;
  if (!currentDoc.storage_path || !currentDoc.file_name) {
    const { data: freshDoc, error: fetchErr } = await supabase
      .from('documents')
      .select('*')
      .eq('id', docData.id)
      .single();
    if (fetchErr || !freshDoc) {
      throw new Error('Document not found or access denied.');
    }
    currentDoc = freshDoc;
  }

  // Set status to processing
  await supabase.from('documents').update({ status: 'processing' }).eq('id', currentDoc.id);

  let buffer = fileBuffer;
  if (!buffer) {
    if (!currentDoc.storage_path) {
      throw new Error('Document has no storage path.');
    }
    const { data: fileBlob, error: downloadError } = await supabase.storage
      .from('enterprisedocumentstorage')
      .download(currentDoc.storage_path);

    if (downloadError || !fileBlob) {
      await supabase.from('documents').update({ status: 'error' }).eq('id', currentDoc.id);
      throw new Error(`Failed to download file from storage: ${downloadError?.message || 'Empty file'}`);
    }
    buffer = Buffer.from(await fileBlob.arrayBuffer());
  }

  // Extract text with page numbers
  const { PDFParse } = await import('pdf-parse');
  const parser = new PDFParse({ data: new Uint8Array(buffer) });
  const result = await parser.getText();

  let extractedText = '';
  const pageChunks = [];

  if (result.pages && result.pages.length > 0) {
    for (const page of result.pages) {
      const pageText = (page.text || '').trim();
      if (pageText.length > 0) {
        extractedText += `\n\n[Page ${page.num}]\n${pageText}`;
        const subChunks = chunkText(pageText, { chunkSize: 1000, chunkOverlap: 150 });
        for (const sc of subChunks) {
          pageChunks.push({
            content: `[Page ${page.num}] ${sc.content}`
          });
        }
      }
    }
  }

  extractedText = extractedText.trim();
  if (!extractedText && result.text) {
    extractedText = result.text.trim();
  }

  // Scanned PDF check (< 50 characters)
  const cleanedText = extractedText.replace(/\s+/g, '').trim();
  if (cleanedText.length < 50) {
    await supabase.from('documents').update({ status: 'ocr_required' }).eq('id', currentDoc.id);
    return {
      success: true,
      status: 'ocr_required',
      message: 'Document appears to be scanned or contains insufficient text. OCR is required.',
      totalChunks: 0,
      textLength: extractedText.length
    };
  }

  const MAX_TEXT_LENGTH = 500000;
  const textToSave = extractedText.length > MAX_TEXT_LENGTH ? extractedText.substring(0, MAX_TEXT_LENGTH) : extractedText;

  const rawChunks = pageChunks.length > 0 ? pageChunks : chunkText(textToSave, { chunkSize: 1000, chunkOverlap: 150 });
  const chunks = rawChunks.map((c, i) => ({
    chunk_index: i,
    content: c.content
  }));

  if (chunks.length === 0) {
    throw new Error('No usable text passages could be generated from document.');
  }

  // Generate 1536-dimensional embeddings with Gemini
  const embeddings = await generateEmbeddings(chunks.map(c => c.content));
  if (!embeddings || embeddings.length !== chunks.length) {
    throw new Error(`Embedding count mismatch: expected ${chunks.length}, got ${embeddings?.length || 0}`);
  }

  const chunksPayload = chunks.map((c, idx) => ({
    chunk_index: c.chunk_index,
    content: c.content,
    embedding: JSON.stringify(embeddings[idx])
  }));

  // Transactional replacement in Supabase
  const { data: rpcCount, error: rpcError } = await supabase.rpc('replace_document_chunks', {
    p_document_id: currentDoc.id,
    p_chunks: chunksPayload
  });

  if (rpcError) {
    console.error('replace_document_chunks failed in pipeline:', rpcError);
    throw new Error(`Failed to store document chunks in database: ${rpcError.message}`);
  }

  let finalStatus = 'completed';
  const { error: updateError } = await supabase
    .from('documents')
    .update({ 
      content: textToSave, 
      status: finalStatus 
    })
    .eq('id', currentDoc.id);

  if (updateError && updateError.code === '23514') {
    for (const fb of ['ready', 'processed', currentDoc.status]) {
      const fbRes = await supabase
        .from('documents')
        .update({ content: textToSave, status: fb })
        .eq('id', currentDoc.id);
      if (!fbRes.error) {
        finalStatus = fb;
        break;
      }
    }
  }

  return {
    success: true,
    status: finalStatus,
    documentId: currentDoc.id,
    fileName: currentDoc.file_name,
    totalChunks: typeof rpcCount === 'number' ? rpcCount : chunks.length,
    textLength: textToSave.length,
    message: `Successfully processed ${currentDoc.file_name}: extracted text and generated ${chunks.length} vector embeddings.`
  };
}

// Secure Endpoint to chunk / process a document
app.post('/api/documents/:id/chunk', async (req, res) => {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader) return res.status(401).json({ error: 'Missing Authorization header' });
    const token = authHeader.replace('Bearer ', '');

    const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY, {
      global: { headers: { Authorization: `Bearer ${token}` } }
    });

    const { data: { user }, error: authError } = await supabase.auth.getUser();
    if (authError || !user) return res.status(401).json({ error: 'Invalid token' });

    const { data: docData, error: docError } = await supabase
      .from('documents')
      .select('*')
      .eq('id', req.params.id)
      .single();

    if (docError || !docData) {
      return res.status(404).json({ error: 'Document not found or access denied.' });
    }

    const processResult = await processDocumentPipeline(supabase, docData);
    res.json(processResult);
  } catch (err) {
    console.error('Chunk endpoint error:', err);
    res.status(500).json({ error: err.message || 'Internal server error during chunking.' });
  }
});

// Dedicated Reprocess Endpoint to safely re-extract, re-chunk, and re-embed existing documents
app.post('/api/documents/:id/reprocess', async (req, res) => {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader) return res.status(401).json({ error: 'Missing Authorization header' });
    const token = authHeader.replace('Bearer ', '');

    const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY, {
      global: { headers: { Authorization: `Bearer ${token}` } }
    });

    const { data: { user }, error: authError } = await supabase.auth.getUser();
    if (authError || !user) return res.status(401).json({ error: 'Invalid token' });

    const { data: docData, error: docError } = await supabase
      .from('documents')
      .select('*')
      .eq('id', req.params.id)
      .single();

    if (docError || !docData) {
      return res.status(404).json({ error: 'Document not found or access denied.' });
    }

    const processResult = await processDocumentPipeline(supabase, docData);
    res.json(processResult);
  } catch (err) {
    console.error('Reprocess endpoint error:', err);
    res.status(500).json({ error: err.message || 'Internal server error during reprocessing.' });
  }
});

// Authenticated Endpoint to view document chunks
app.get('/api/documents/:id/chunks', async (req, res) => {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader) return res.status(401).json({ error: 'Missing Authorization header' });
    const token = authHeader.replace('Bearer ', '');

    const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY, {
      global: { headers: { Authorization: `Bearer ${token}` } }
    });

    const { data: { user }, error: authError } = await supabase.auth.getUser();
    if (authError || !user) return res.status(401).json({ error: 'Invalid token' });

    // Verify user has access to document
    const { data: docData, error: docError } = await supabase
      .from('documents')
      .select('id, tenant_id, file_name, status')
      .eq('id', req.params.id)
      .single();

    if (docError || !docData) {
      return res.status(404).json({ error: 'Document not found or access denied.' });
    }

    // Retrieve chunks ordered by chunk_index scoped to tenant
    const { data: chunks, error: chunksError } = await supabase
      .from('document_chunks')
      .select('id, chunk_index, content, created_at')
      .eq('document_id', docData.id)
      .eq('tenant_id', docData.tenant_id)
      .order('chunk_index', { ascending: true });

    if (chunksError) {
      console.error("Error fetching document chunks:", chunksError);
      return res.status(500).json({ error: 'Failed to retrieve chunks from database.' });
    }

    res.json({
      documentId: docData.id,
      fileName: docData.file_name,
      totalChunks: (chunks || []).length,
      chunks: chunks || []
    });
  } catch (err) {
    console.error('Fetch chunks error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Authenticated endpoint to generate/backfill embeddings for existing document chunks
app.post('/api/documents/:id/embed', async (req, res) => {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader) return res.status(401).json({ error: 'Missing Authorization header' });
    const token = authHeader.replace('Bearer ', '');

    const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY, {
      global: { headers: { Authorization: `Bearer ${token}` } }
    });

    const { data: { user }, error: authError } = await supabase.auth.getUser();
    if (authError || !user) return res.status(401).json({ error: 'Invalid token' });

    // Verify document belongs to user's workspace
    const { data: docData, error: docError } = await supabase
      .from('documents')
      .select('id, tenant_id, file_name')
      .eq('id', req.params.id)
      .single();

    if (docError || !docData) {
      return res.status(404).json({ error: 'Document not found or access denied.' });
    }

    // Fetch chunks for this document
    const { data: chunks, error: chunksError } = await supabase
      .from('document_chunks')
      .select('id, chunk_index, content, embedding')
      .eq('document_id', docData.id)
      .eq('tenant_id', docData.tenant_id)
      .order('chunk_index', { ascending: true });

    if (chunksError || !chunks || chunks.length === 0) {
      return res.status(400).json({ error: 'No chunks found for this document. Please chunk the document first.' });
    }

    const chunksToEmbed = chunks.filter(c => !c.embedding);
    if (chunksToEmbed.length === 0) {
      return res.json({ 
        success: true, 
        message: 'All chunks already have embeddings.', 
        totalChunks: chunks.length 
      });
    }

    const embeddings = await generateEmbeddings(chunksToEmbed.map(c => c.content));

    for (let i = 0; i < chunksToEmbed.length; i++) {
      const chunk = chunksToEmbed[i];
      const emb = embeddings[i];
      if (emb) {
        await supabase
          .from('document_chunks')
          .update({ embedding: JSON.stringify(emb) })
          .eq('id', chunk.id)
          .eq('tenant_id', docData.tenant_id);
      }
    }

    res.json({
      success: true,
      documentId: docData.id,
      fileName: docData.file_name,
      embeddedCount: chunksToEmbed.length,
      totalChunks: chunks.length,
      message: `Generated and stored ${chunksToEmbed.length} embeddings.`
    });
  } catch (err) {
    console.error('Embed endpoint error:', err);
    res.status(500).json({ error: err.message || 'Internal server error during embedding.' });
  }
});

// Authenticated Question-Answering Endpoint (RAG)
app.post('/api/chat/ask', async (req, res) => {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader) return res.status(401).json({ error: 'Missing Authorization header' });
    const token = authHeader.replace('Bearer ', '');

    const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY, {
      global: { headers: { Authorization: `Bearer ${token}` } }
    });

    const { data: { user }, error: authError } = await supabase.auth.getUser();
    if (authError || !user) return res.status(401).json({ error: 'Invalid token' });

    const { question, documentId } = req.body;
    if (!question || typeof question !== 'string' || question.trim().length === 0) {
      return res.status(400).json({ error: 'Question text is required.' });
    }

    if (!process.env.GEMINI_API_KEY && !process.env.GOOGLE_API_KEY) {
      return res.status(500).json({ error: 'GEMINI_API_KEY or GOOGLE_API_KEY is not configured on the server.' });
    }

    // Look up user workspace tenant
    const { data: membership, error: memError } = await supabase
      .from('tenant_memberships')
      .select('tenant_id')
      .eq('user_id', user.id)
      .limit(1)
      .single();

    if (memError || !membership) {
      return res.status(403).json({ error: 'User does not belong to any workspace.' });
    }

    const tenantId = membership.tenant_id;

    // 1. Generate query embedding with gemini-embedding-001 (1536 dimensions)
    const [queryEmbedding] = await generateEmbeddings([question.trim()]);
    if (!queryEmbedding) {
      return res.status(500).json({ error: 'Failed to generate embedding for question.' });
    }

    // 2. Vector search in database via match_document_chunks RPC
    let { data: matches, error: matchError } = await supabase.rpc('match_document_chunks', {
      query_embedding: JSON.stringify(queryEmbedding),
      match_count: 5,
      filter_tenant_id: tenantId,
      filter_document_id: documentId || null
    });

    if (matchError) {
      console.error('Vector search match error:', matchError);
      return res.status(500).json({ 
        error: 'Vector search failed. Ensure match_document_chunks migration has been applied.',
        details: matchError.message
      });
    }

    // Auto-healing: If no matches, check if any workspace documents have 0 chunks and auto-process them
    if (!matches || matches.length === 0) {
      const { data: tenantDocs } = await supabase
        .from('documents')
        .select('id, file_name, storage_path, status, content')
        .eq('tenant_id', tenantId);

      if (tenantDocs && tenantDocs.length > 0) {
        let anyReindexed = false;
        for (const tDoc of tenantDocs) {
          const { count } = await supabase
            .from('document_chunks')
            .select('id', { count: 'exact', head: true })
            .eq('document_id', tDoc.id);

          if (!count || count === 0) {
            try {
              console.log(`Auto-indexing document without chunks: ${tDoc.file_name} (${tDoc.id})`);
              await processDocumentPipeline(supabase, tDoc);
              anyReindexed = true;
            } catch (reindexErr) {
              console.warn(`Failed auto-indexing doc ${tDoc.id}:`, reindexErr.message);
            }
          }
        }

        if (anyReindexed) {
          const retrySearch = await supabase.rpc('match_document_chunks', {
            query_embedding: JSON.stringify(queryEmbedding),
            match_count: 5,
            filter_tenant_id: tenantId,
            filter_document_id: documentId || null
          });
          if (retrySearch.data && retrySearch.data.length > 0) {
            matches = retrySearch.data;
          }
        }
      }
    }

    if (!matches || matches.length === 0) {
      return res.json({
        answer: "The provided documents do not contain enough information to answer this question. (No relevant document chunks with embeddings were found in your workspace).",
        citations: [],
        sourcesCount: 0
      });
    }

    // 3. Prepare Grounded Prompt for Gemini 3.8 Flash
    const contextPassages = matches.map((m) => {
      const pageMatch = m.content.match(/\[Page\s+(\d+)\]/i);
      const pageInfo = pageMatch ? `, Page ${pageMatch[1]}` : '';
      return `[Document: ${m.file_name}${pageInfo}, Passage #${m.chunk_index + 1}]\n${m.content}`;
    }).join('\n\n---\n\n');

    const systemPrompt = `You are VaultAI, an enterprise document assistant.
Answer the user's question accurately and concisely, strictly based on the provided document excerpts.
Rules:
1. Only use facts directly stated in the context excerpts.
2. If the context does not contain enough information to answer the question, clearly state: "The provided documents do not contain enough information to answer this question."
3. Cite your sources naturally in your answer using [Filename, Page #X] (or [Filename, Passage #X]) notation.
4. Never extrapolate or make up facts.`;

    const userPrompt = `Context excerpts:\n${contextPassages}\n\nQuestion: ${question.trim()}\n\nAnswer:`;

    const ai = getGeminiClient();
    let genRes;
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        genRes = await ai.models.generateContent({
          model: 'gemini-3.8-flash',
          contents: `${systemPrompt}\n\n${userPrompt}`
        });
        break;
      } catch (genErr) {
        if (attempt < 3 && (genErr.status === 503 || genErr.message?.includes('high demand') || genErr.status === 429)) {
          console.warn(`Gemini generation retry ${attempt} due to demand spike:`, genErr.message);
          await new Promise(r => setTimeout(r, 1500 * attempt));
          continue;
        }
        throw genErr;
      }
    }

    const answer = genRes?.text?.trim() || "No answer could be generated.";

    const citations = matches.map(m => {
      const pageMatch = m.content.match(/\[Page\s+(\d+)\]/i);
      const pageNumber = pageMatch ? parseInt(pageMatch[1], 10) : null;
      return {
        fileName: m.file_name,
        documentId: m.document_id,
        passageNumber: m.chunk_index + 1,
        pageNumber: pageNumber,
        similarity: Math.round(m.similarity * 100) / 100,
        snippet: m.content.replace(/\[Page\s+\d+\]\s*/i, '').substring(0, 160) + (m.content.length > 160 ? '...' : '')
      };
    });

    res.json({
      success: true,
      answer,
      citations,
      sourcesCount: matches.length
    });
  } catch (err) {
    console.error('Chat ask endpoint error:', err);
    res.status(500).json({ error: err.message || 'Internal server error during question answering.' });
  }
});

// Public config endpoint for frontend Supabase client
app.get('/api/config', (req, res) => {
  res.json({
    supabaseUrl: process.env.SUPABASE_URL,
    supabaseAnonKey: process.env.SUPABASE_ANON_KEY
  });
});

// 404 handler for unknown API routes in Express 5
app.use('/api', (req, res) => {
  res.status(404).json({ error: 'API endpoint not found' });
});

// Fallback to index.html for SPA behavior if needed
app.use((req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(port, host, () => {
  console.log(`VaultAI server running on http://${host}:${port}`);
});

export default app;
