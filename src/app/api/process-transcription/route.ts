import { NextRequest, NextResponse } from 'next/server';
import { writeFile, mkdir, readFile, unlink } from 'fs/promises';
import path from 'path';
import { existsSync } from 'fs';
import { v4 as uuidv4 } from 'uuid';
import { GoogleGenerativeAI, HarmCategory, HarmBlockThreshold, SchemaType } from "@google/generative-ai";
import unidecode from 'unidecode';
import logger from '@/utils/logger';
import { execPromise } from '@/lib/server-utils';
import { updateGlobalProgress, setProcessingStatus } from '../progress/route';
import fs from 'fs';
import { promises as fsPromises } from 'fs';
import os from 'os';

// Create a temporary directory for processing
async function createTempDirectory() {
    const tempDir = path.join(os.tmpdir(), 'clear-notes-' + uuidv4());
    await fsPromises.mkdir(tempDir, { recursive: true });
    return tempDir;
}

// Ensure directories exist
async function ensureDirectories() {
    const artifactsDir = path.join(process.cwd(), 'artifacts');
    const pdfArtifactsDir = path.join(process.cwd(), 'artifacts');

    if (!existsSync(artifactsDir)) {
        await mkdir(artifactsDir, { recursive: true });
    }

    if (!existsSync(pdfArtifactsDir)) {
        await mkdir(pdfArtifactsDir, { recursive: true });
    }

    return { artifactsDir, pdfArtifactsDir };
}

// Export the function so it can be used by other routes
export { ensureDirectories };

// Process the transcription JSON
function processTranscription(transcriptionData: any): string[] {
    // Group words by speaker_id
    const wordsBySpeaker: Record<string, any[]> = {};

    // Extract words and group them by speaker_id
    transcriptionData.words?.forEach((item: any) => {
        if (item.type !== 'audio_event') {
            const speakerId = item.speaker_id || 'unknown_speaker';
            if (!wordsBySpeaker[speakerId]) {
                wordsBySpeaker[speakerId] = [];
            }
            wordsBySpeaker[speakerId].push(item);
        }
    });

    // Process each speaker's words separately
    const allParagraphs: string[] = [];

    for (const speakerId in wordsBySpeaker) {
        const speakerWords = wordsBySpeaker[speakerId];

        // Combine the filtered words into a single text for this speaker
        let speakerText = speakerWords
            .map((item: any) => item.text)
            .join('');

        // Remove all non-ASCII characters
        speakerText = unidecode(speakerText);

        // Process text to handle special cases
        let processedText = speakerText
            // Handle ellipsis (triple dots) - replace with a placeholder
            .replace(/\.{3,}/g, '___ELLIPSIS___')
            // Handle common abbreviations
            .replace(/\b(Mr|Mrs|Ms|Dr|Prof|Inc|Ltd|Co|St|Ave|Blvd|Rd|Hwy|Fig|Eq)\./g, '$1___ABBR___')
            // Handle common numeric patterns (e.g., 3.14, 1.5, etc.)
            .replace(/\b\d+\.\d+/g, (match: string) => match.replace('.', '___DECIMAL___'));

        // Split on actual sentence boundaries
        const sentences = processedText
            // Split on period, question mark, or exclamation mark followed by space or end of string
            .replace(/([.!?])\s+(?=[A-Z])/g, '$1|')
            // Also catch end of sentences that might be at the end of the text
            .replace(/([.!?])$/g, '$1|')
            .split('|')
            .map((sentence: string) => {
                // Restore our placeholders
                return sentence
                    .replace(/___ELLIPSIS___/g, '...')
                    .replace(/___ABBR___/g, '.')
                    .replace(/___DECIMAL___/g, '.');
            })
            .filter((sentence: string) => sentence.trim().length > 0);

        // Group sentences into paragraphs (5-6 sentences per paragraph)
        const sentencesPerParagraph = 10;

        for (let i = 0; i < sentences.length; i += sentencesPerParagraph) {
            const paragraph = sentences
                .slice(i, i + sentencesPerParagraph)
                .join(' ');

            if (paragraph.trim().length > 0) {
                // Add speaker identifier to the paragraph
                const speakerPrefix = speakerId !== 'unknown_speaker'
                    ? `[Speaker ${speakerId.replace('speaker_', '')}]: `
                    : '';
                allParagraphs.push(speakerPrefix + paragraph);
            }
        }
    }

    return allParagraphs;
}

// Export the function so it can be used by other routes
export { processTranscription };

// Process paragraphs through Gemini API
async function processParagraphsWithGemini(
    paragraphs: string[],
    setProgress: (progress: number) => void,
    language: string
): Promise<{ text: string, footnotes: Map<number, string[]> }> {
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) {
        logger.error("GEMINI_API_KEY environment variable is not set");
        // Return original paragraphs if API key is not set
        return {
            text: paragraphs.join(' '),
            footnotes: new Map()
        };
    }

    // Rate limiter implementation - token bucket with 15 requests per minute
    const MAX_TOKENS = 15; // Maximum 15 requests per minute
    const REFILL_RATE = 15 / 60; // Tokens per second (15 per minute)
    let tokens = MAX_TOKENS; // Start with a full bucket
    let lastRefillTimestamp = Date.now();

    // Function to take a token, waiting if necessary
    const takeToken = async () => {
        const now = Date.now();
        const elapsedSeconds = (now - lastRefillTimestamp) / 1000;

        // Refill tokens based on elapsed time
        tokens = Math.min(MAX_TOKENS, tokens + elapsedSeconds * REFILL_RATE);
        lastRefillTimestamp = now;

        if (tokens < 1) {
            // Not enough tokens, calculate wait time
            const waitTime = Math.ceil((1 - tokens) / REFILL_RATE) * 1000;
            logger.warn(`Rate limit reached. Waiting ${waitTime}ms before next request...`);
            await new Promise(resolve => setTimeout(resolve, waitTime));
            tokens = 1; // After waiting, we have at least one token
            lastRefillTimestamp = Date.now();
        }

        // Consume one token
        tokens -= 1;
    };

    // Helper function to wait for a specified time
    const wait = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

    // Helper function to process a single paragraph with retry logic
    const processParagraphWithRetry = async (
        model: any,
        paragraph: string,
        maxRetries = 3,
        retryDelay = 60000 // 60 seconds delay between retries
    ) => {
        let retries = 0;

        while (retries <= maxRetries) {
            try {
                const result = await model.generateContent(paragraph);
                const responseText = result.response.text();

                // Parse the JSON response
                let parsedResponse;
                try {
                    parsedResponse = JSON.parse(responseText);
                    return {
                        success: true,
                        data: parsedResponse
                    };
                } catch (e) {
                    logger.warn("Failed to parse JSON response:", e);

                    // If response is not valid JSON, try to extract JSON from the text
                    const jsonMatch = responseText.match(/\{[\s\S]*\}/);
                    if (jsonMatch) {
                        try {
                            parsedResponse = JSON.parse(jsonMatch[0]);
                            logger.info("Successfully extracted JSON from response");
                            return {
                                success: true,
                                data: parsedResponse
                            };
                        } catch (e2) {
                            logger.error("Failed to parse JSON from extracted match:", e2);
                            // Will be handled in the retry logic
                            throw new Error("Failed to parse JSON from extracted match");
                        }
                    } else {
                        logger.error("Response is not valid JSON and couldn't extract JSON");
                        throw new Error("Invalid JSON response");
                    }
                }
            } catch (error) {
                retries++;
                const paragraphNumber = paragraphs.findIndex(p => p === paragraph);
                if (retries <= maxRetries) {
                    // Log the paragraph number
                    logger.error(`Error processing paragraph ${paragraphNumber + 1}, retrying (${retries}/${maxRetries}) after ${retryDelay / 1000} seconds: ${error}`);
                    await wait(retryDelay);
                } else {
                    logger.error(`Failed to process paragraph ${paragraphNumber + 1} after ${maxRetries} retries: ${error}`);
                    return {
                        success: false,
                        error
                    };
                }
            }
        }

        // This should never be reached due to the return in the else block above
        return {
            success: false,
            error: new Error("Maximum retries exceeded")
        };
    };

    try {
        const genAI = new GoogleGenerativeAI(apiKey);

        // Set up the chat session with JSON response format
        const processedParagraphs: string[] = [];
        const paragraphFootnotes = new Map<number, string[]>();
        const model = genAI.getGenerativeModel({
            model: "learnlm-1.5-pro-experimental",
            generationConfig: {
                temperature: 0.15,
                topP: 0.95,
                topK: 20,
                maxOutputTokens: 8192,
                responseMimeType: "application/json",
                responseSchema: {
                    type: SchemaType.OBJECT,
                    properties: {
                        processed_text: {
                            type: SchemaType.STRING,
                            description: `The processed version of the paragraph. The text MUST be in its original language: ${getLanguageDisplayName(language)}.`
                        },
                        caveats: {
                            type: SchemaType.STRING,
                            description: `A not-too-long paragraph explaining the caveats encountered while processing the input text excerpt. If there were specific parts that were difficult to interpret, quote them and explain why. If the paragraph was successfully processed without issues, don't include this field. USE THIS FIELD ONLY IF STRICTLY NECESSARY.`
                        }
                    },
                    required: ["processed_text"]
                }
            },
            systemInstruction: `I am going to provide you with the excerpt of a transcription of a university lesson.
The original text will probably contain speech disfluencies, repetitions, fragmented sentences, conversational markers (e.g., "ok?", "ehm", "cioè", "um", "uh", "umh"), and unclear transitions.
Given this text, you should output a single, clear, professional and readable paragraph that doesn't lose any information and reasoning lines from the original text. It should read like the professor is speaking.
Basically, you're going to be an assistant at deciphering such transcription by processing the excerpt.
Please strictly preserve all technical language and phraseology. It's fundamental for the quality of the output.
If you encounter any parts that are difficult to interpret, provide the best possible output text and include any caveats in the 'caveats' field.
Words or sentences in other languages that are present in the excerpt should also be processed, but not translated. This is in order to preserve the original meaning and intent of the professor.
Interpret formulas and mathematical expressions in LaTeX format based on speech in the original language of the excerpt. Be proactive and use your knowledge of the language to infer its correct interpretation.
Write the equations using the inline LaTeX format, wrapped in $ only. Use the actual mathematical form instead of spanning things out in a long form.
Chemical formulas should be written in LaTeX format, wrapped in $ only. For example, "H2O" should be written as $\\text{H}_2\\text{O}$.
`,
        });

        // Group paragraphs by speaker to maintain context
        const speakerGroups: Record<string, string[]> = {};

        // Extract speaker ID from each paragraph and group them
        paragraphs.forEach(paragraph => {
            const speakerMatch = paragraph.match(/^\[Speaker (\d+)\]:(.*)/);
            const speakerId = speakerMatch ? `speaker_${speakerMatch[1]}` : 'unknown_speaker';

            if (!speakerGroups[speakerId]) {
                speakerGroups[speakerId] = [];
            }

            speakerGroups[speakerId].push(paragraph);
        });

        // Create a progress updater that updates the global progress
        const updateProgress = (progress: number) => {
            // Call the original setProgress function
            setProgress(progress);
            
            // Also update the global progress
            updateGlobalProgress(progress);
        };

        // Process each speaker's paragraphs separately
        let processedCount = 0;
        const totalParagraphs = paragraphs.length;

        for (const speakerId in speakerGroups) {
            const speakerParagraphs = speakerGroups[speakerId];

            // Process paragraphs with rate limiting
            for (let i = 0; i < speakerParagraphs.length; i++) {
                // Update progress
                processedCount++;
                const progress = Math.round((processedCount / totalParagraphs) * 100);
                updateProgress(progress);

                // Apply rate limiting before making the API request
                await takeToken();

                // Process paragraph with retry logic
                const prompt = speakerParagraphs[i];
                const result = await processParagraphWithRetry(model, prompt);

                if (result.success) {
                    const parsedResponse = result.data;
                    const processedText = parsedResponse.processed_text || speakerParagraphs[i];
                    const caveats = parsedResponse.caveats === 'None' ? '' : parsedResponse.caveats || '';

                    // Find the actual index in the original paragraphs array
                    const originalIndex = paragraphs.findIndex(p => p === speakerParagraphs[i]);

                    if (caveats.length > 0) {
                        logger.warn(`The paragraph ${processedCount} has caveats: \"${caveats}\"`);
                        // Always use the processed text, even if there are caveats
                        processedParagraphs.push(processedText);
                        if (originalIndex !== -1) {
                            paragraphFootnotes.set(originalIndex, [caveats]);
                        }
                    } else {
                        processedParagraphs.push(processedText);
                        if (originalIndex !== -1) {
                            // No footnotes needed when there are no caveats
                        }
                    }
                } else {
                    // If all retries failed, use the original paragraph
                    logger.error(`All retries failed for paragraph ${processedCount}. Using original text.`);
                    processedParagraphs.push(speakerParagraphs[i]);

                    // Find the actual index in the original paragraphs array
                    const originalIndex = paragraphs.findIndex(p => p === speakerParagraphs[i]);
                    if (originalIndex !== -1) {
                        paragraphFootnotes.set(originalIndex, ["Failed to process paragraph after multiple retries."]);
                    }
                }
            }
        }

        // Join all processed paragraphs with double newlines for better readability
        return {
            text: processedParagraphs.join(' '),
            footnotes: paragraphFootnotes
        };
    } catch (error) {
        logger.error("Error in processParagraphsWithGemini:", error);
        // Return original paragraphs on error
        return {
            text: paragraphs.join(' '),
            footnotes: new Map()
        };
    }
}

// Export the function so it can be used by other routes
export { processParagraphsWithGemini };

// Escape special LaTeX characters, handling cases for multiple consecutive special characters.
function escapeLatex(text: string): string {
    let result = text;
    const specialChars = ['%'];
    specialChars.forEach(char => {
        const regex = new RegExp(`\\${char}`, 'g');
        result = result.replace(regex, `\\${char}`);
    });
    return result;
}

// Generate LaTeX document
function generateLatexDocument(text: string, footnotes: Map<number, string[]> = new Map()): string {
    // Split the text into paragraphs
    const paragraphs = text.split('\n');

    // Group contiguous paragraphs by speaker
    const groupedContent: string[] = [];
    let currentSpeaker: string | null = null;
    let currentGroup: string[] = [];

    paragraphs.forEach((paragraph, index) => {
        // Check if paragraph starts with a speaker identifier
        const speakerMatch = paragraph.match(/^\[Speaker (\d+)\]:(.*)/);

        if (speakerMatch) {
            // Extract speaker number and content
            const speakerNum = speakerMatch[1];
            const content = speakerMatch[2].trim();

            // Format content (without speaker prefix, as it will be in the subsection)
            let formattedContent = escapeLatex(content);

            // Add footnotes if needed
            const caveats = footnotes.get(index)?.[0];

            if (caveats) {
                formattedContent = `${formattedContent}\\footnote{${escapeLatex(caveats)}}`;
            }

            // If this is a new speaker or the first paragraph
            if (speakerNum !== currentSpeaker) {
                // Add the previous group if it exists
                if (currentGroup.length > 0) {
                    groupedContent.push(`\\subsection*{Speaker ${currentSpeaker}}\n${currentGroup.join('\n')}`);
                    currentGroup = [];
                }

                // Set the new current speaker
                currentSpeaker = speakerNum;
            }

            // Add the formatted content to the current group
            currentGroup.push(formattedContent);
        } else {
            // Handle paragraphs without speaker identifiers
            let formattedContent = escapeLatex(paragraph);

            const caveats = footnotes.get(index)?.[0];

            if (caveats) {
                formattedContent = `${formattedContent}\\footnote{${escapeLatex(caveats)}}`;
            }

            // Add to current group if one exists, otherwise create a new group with no speaker
            if (currentGroup.length > 0) {
                currentGroup.push(formattedContent);
            } else {
                groupedContent.push(formattedContent);
            }
        }
    });

    // Add the last group if it exists
    if (currentGroup.length > 0 && currentSpeaker !== null) {
        groupedContent.push(`\\subsection*{Speaker ${currentSpeaker}}\n${currentGroup.join('\n')}`);
    }

    return `\\documentclass[11pt, a4paper]{article}
\\usepackage[utf8]{inputenc}
\\usepackage[T1]{fontenc}
\\usepackage{lmodern}
\\usepackage{microtype}
\\usepackage[margin=0.75in]{geometry}
\\usepackage{parskip}
\\usepackage{setspace}
\\usepackage{amsmath}
\\usepackage{amsfonts}
\\usepackage{xcolor}
\\usepackage[autostyle, english = american]{csquotes}
\\MakeOuterQuote{"}
\\setlength{\\parindent}{1em}

\\title{Transcription}
\\author{ClearNotes}
\\date{\\today}

\\begin{document}
\\maketitle
\\begin{spacing}{1.15}
${groupedContent.join('\n')}
\\end{spacing}
\\end{document}`;
}

// Export the function so it can be used by other routes
export { generateLatexDocument };

// Get language display name
function getLanguageDisplayName(languageCode: string): string {
    const languageMap: Record<string, string> = {
        'afr': 'Afrikaans',
        'amh': 'Amharic',
        'ara': 'Arabic',
        'hye': 'Armenian',
        'asm': 'Assamese',
        'ast': 'Asturian',
        'aze': 'Azerbaijani',
        'bel': 'Belarusian',
        'ben': 'Bengali',
        'bos': 'Bosnian',
        'bul': 'Bulgarian',
        'mya': 'Burmese',
        'yue': 'Cantonese',
        'cat': 'Catalan',
        'ceb': 'Cebuano',
        'nya': 'Chichewa',
        'hrv': 'Croatian',
        'ces': 'Czech',
        'dan': 'Danish',
        'nld': 'Dutch',
        'eng': 'English',
        'est': 'Estonian',
        'fil': 'Filipino',
        'fin': 'Finnish',
        'fra': 'French',
        'ful': 'Fulah',
        'glg': 'Galician',
        'lug': 'Ganda',
        'kat': 'Georgian',
        'deu': 'German',
        'ell': 'Greek',
        'guj': 'Gujarati',
        'hau': 'Hausa',
        'heb': 'Hebrew',
        'hin': 'Hindi',
        'hun': 'Hungarian',
        'isl': 'Icelandic',
        'ibo': 'Igbo',
        'ind': 'Indonesian',
        'gle': 'Irish',
        'ita': 'Italian',
        'jpn': 'Japanese',
        'jav': 'Javanese',
        'kea': 'Kabuverdianu',
        'kan': 'Kannada',
        'kaz': 'Kazakh',
        'khm': 'Khmer',
        'kor': 'Korean',
        'kur': 'Kurdish',
        'kir': 'Kyrgyz',
        'lao': 'Lao',
        'lav': 'Latvian',
        'lin': 'Lingala',
        'lit': 'Lithuanian',
        'luo': 'Luo',
        'ltz': 'Luxembourgish',
        'mkd': 'Macedonian',
        'msa': 'Malay',
        'mal': 'Malayalam',
        'mlt': 'Maltese',
        'cmn': 'Mandarin Chinese',
        'mri': 'Māori',
        'mar': 'Marathi',
        'mon': 'Mongolian',
        'nep': 'Nepali',
        'nso': 'Northern Sotho',
        'nor': 'Norwegian',
        'oci': 'Occitan',
        'ori': 'Odia',
        'pus': 'Pashto',
        'fas': 'Persian',
        'pol': 'Polish',
        'por': 'Portuguese',
        'pan': 'Punjabi',
        'ron': 'Romanian',
        'rus': 'Russian',
        'srp': 'Serbian',
        'sna': 'Shona',
        'snd': 'Sindhi',
        'slk': 'Slovak',
        'slv': 'Slovenian',
        'som': 'Somali',
        'spa': 'Spanish',
        'swa': 'Swahili',
        'swe': 'Swedish',
        'tam': 'Tamil',
        'tgk': 'Tajik',
        'tel': 'Telugu',
        'tha': 'Thai',
        'tur': 'Turkish',
        'ukr': 'Ukrainian',
        'umb': 'Umbundu',
        'urd': 'Urdu',
        'uzb': 'Uzbek',
        'vie': 'Vietnamese',
        'cym': 'Welsh',
        'wol': 'Wolof',
        'xho': 'Xhosa',
        'zul': 'Zulu',
    };

    return languageMap[languageCode] || 'English';
}

export async function POST(request: NextRequest) {
    let tempDir = '';
    
    try {
        // Reset the global progress at the start
        updateGlobalProgress(0);
        // Set processing status to active
        setProcessingStatus(true);
        
        // Create a temporary directory for processing
        tempDir = await createTempDirectory();
        
        // Parse the form data
        const formData = await request.formData();
        const transcriptionFile = formData.get('transcription') as File;
        const language = formData.get('language') as string || 'eng'; // Default to English if not provided
        const wantsStream = formData.get('stream') === 'true';

        if (!transcriptionFile) {
            return NextResponse.json(
                { error: 'No transcription file provided' },
                { status: 400 }
            );
        }

        // Read the file content
        const fileBuffer = Buffer.from(await transcriptionFile.arrayBuffer());
        const transcriptionData = JSON.parse(fileBuffer.toString());

        // Process the transcription to get paragraphs
        const paragraphs = processTranscription(transcriptionData);

        // If client wants streaming updates, use a streaming response
        if (wantsStream) {
            const encoder = new TextEncoder();
            const stream = new TransformStream();
            const writer = stream.writable.getWriter();

            // Create a progress updater that writes to the stream
            const streamProgress = async (progress: number) => {
                // logger.info(`Sending progress update to client: ${progress}%`);
                // Format the SSE message according to the standard
                const message = `data: ${JSON.stringify({ progress })}\n\n`;
                try {
                    await writer.write(encoder.encode(message));
                } catch (error) {
                    logger.error('Error sending progress update:', error);
                    await writer.close();
                    throw error;
                }
            };

            // Start processing in the background
            (async () => {
                try {
                    // Process paragraphs through Gemini API with progress updates
                    const { text: processedText, footnotes } = await processParagraphsWithGemini(
                        paragraphs,
                        streamProgress,
                        language
                    );

                    // Generate LaTeX document
                    const latexContent = generateLatexDocument(processedText, footnotes);

                    // Generate filenames
                    const now = new Date();
                    const datePart = now.toISOString().replace(/[:\-]/g, '').split('.')[0];
                    const baseFilename = transcriptionFile.name.replace(/\.[^/.]+$/, ""); // Remove existing extension
                    const texFilename = `${baseFilename}_${datePart}.tex`;
                    const pdfFilename = `${baseFilename}_${datePart}.pdf`;

                    // Encode LaTeX content to base64 for transmission
                    const base64LatexContent = Buffer.from(latexContent).toString('base64');

                    let pdfSuccess = false;
                    let pdfContent: Buffer | null = null;

                    try {
                        // Write the LaTeX file temporarily
                        const texFilePath = path.join(process.cwd(), texFilename);
                        await writeFile(texFilePath, latexContent);
                        logger.info(`Wrote LaTeX file to: ${texFilePath}`);

                        // Try to compile the PDF
                        const { stdout, stderr } = await execPromise(`./tectonic "${texFilePath}"`);
                        if (stderr) {
                            logger.error(`stderr: ${stderr}`);
                        }
                        logger.info(`stdout: ${stdout}`);

                        // Check if the PDF was generated
                        const generatedPdfPath = path.join(process.cwd(), pdfFilename);
                        logger.info(`Looking for PDF at: ${generatedPdfPath}`);
                        if (fs.existsSync(generatedPdfPath)) {
                            // Read the generated PDF
                            pdfContent = await readFile(generatedPdfPath);
                            pdfSuccess = true;
                            logger.info(`Successfully read PDF file: ${generatedPdfPath}`);

                            // Encode PDF content to base64 for transmission
                            const base64PdfContent = Buffer.from(pdfContent).toString('base64');

                            // Send both LaTeX and PDF content
                            await writer.write(
                                encoder.encode(`data: ${JSON.stringify({ 
                                    complete: true, 
                                    pdfFilename: pdfFilename,
                                    latexFilename: texFilename,
                                    latexContent: base64LatexContent,
                                    pdfContent: base64PdfContent,
                                    pdfAvailable: true
                                })}\n\n`)
                            );

                            // Clean up the generated PDF file
                            try {
                                await fs.promises.unlink(generatedPdfPath);
                                logger.info(`Deleted PDF file: ${generatedPdfPath}`);
                            } catch (error) {
                                logger.error(`Error deleting PDF file ${generatedPdfPath}:`, error);
                            }
                        } else {
                            logger.error(`PDF file not found at: ${generatedPdfPath}`);
                            // If PDF compilation failed, send only LaTeX
                            await writer.write(
                                encoder.encode(`data: ${JSON.stringify({ 
                                    complete: true, 
                                    latexFilename: texFilename,
                                    latexContent: base64LatexContent,
                                    pdfAvailable: false
                                })}\n\n`)
                            );
                        }

                        // Clean up the temporary LaTeX file
                        try {
                            await fs.promises.unlink(texFilePath);
                            logger.info(`Deleted LaTeX file: ${texFilePath}`);
                        } catch (error) {
                            logger.error(`Error deleting LaTeX file ${texFilePath}:`, error);
                        }
                    } catch (error) {
                        logger.error('Error compiling PDF:', error);
                        // If there was an error, send only LaTeX
                        await writer.write(
                            encoder.encode(`data: ${JSON.stringify({ 
                                complete: true, 
                                latexFilename: texFilename,
                                latexContent: base64LatexContent,
                                pdfAvailable: false
                            })}\n\n`)
                        );
                    }

                    // Close the stream
                    await writer.close();
                    // Set processing status to inactive
                    setProcessingStatus(false);
                } catch (error) {
                    logger.error('Error in streaming process:', error);
                    await writer.write(
                        encoder.encode(`data: ${JSON.stringify({ 
                            error: 'Failed to process transcription' 
                        })}\n\n`)
                    );
                    await writer.close();
                    // Set processing status to inactive on error
                    setProcessingStatus(false);
                } finally {
                    // Clean up the temporary directory
                    try {
                        if (tempDir && fs.existsSync(tempDir)) {
                            await fsPromises.rm(tempDir, { recursive: true, force: true });
                            logger.info(`Deleted temporary directory: ${tempDir}`);
                        }
                    } catch (error) {
                        logger.error('Error cleaning up temporary directory:', error);
                    }
                }
            })();

            // Return the stream response
            return new Response(stream.readable, {
                headers: {
                    'Content-Type': 'text/event-stream',
                    'Cache-Control': 'no-cache',
                    'Connection': 'keep-alive',
                    'X-Accel-Buffering': 'no', // Disable buffering for Nginx
                    'Access-Control-Allow-Origin': '*', // Allow CORS
                },
            });
        }

        // Non-streaming path (original implementation)
        // Process paragraphs through Gemini API.  Pass in a dummy setProgress function.
        const { text: processedText, footnotes } = await processParagraphsWithGemini(paragraphs, () => { }, language);

        // Generate LaTeX document
        const latexContent = generateLatexDocument(processedText, footnotes);

        // Generate filenames
        const now = new Date();
        const datePart = now.toISOString().replace(/[:\-]/g, '').split('.')[0];
        const baseFilename = transcriptionFile.name.replace(/\.[^/.]+$/, ""); // Remove existing extension
        const texFilename = `${baseFilename}_${datePart}.tex`;
        const pdfFilename = `${baseFilename}_${datePart}.pdf`;

        // Encode LaTeX content to base64 for transmission
        const base64LatexContent = Buffer.from(latexContent).toString('base64');

        let pdfSuccess = false;
        let pdfContent: Buffer | null = null;

        try {
            // Write the LaTeX file temporarily
            const texFilePath = path.join(process.cwd(), texFilename);
            await writeFile(texFilePath, latexContent);
            logger.info(`Wrote LaTeX file to: ${texFilePath}`);

            // Try to compile the PDF
            const { stdout, stderr } = await execPromise(`./tectonic "${texFilePath}"`);
            if (stderr) {
                logger.error(`stderr: ${stderr}`);
            }
            logger.info(`stdout: ${stdout}`);

            // Check if the PDF was generated
            const generatedPdfPath = path.join(process.cwd(), pdfFilename);
            logger.info(`Looking for PDF at: ${generatedPdfPath}`);
            if (fs.existsSync(generatedPdfPath)) {
                // Read the generated PDF
                pdfContent = await readFile(generatedPdfPath);
                pdfSuccess = true;
                logger.info(`Successfully read PDF file: ${generatedPdfPath}`);

                // Clean up the generated PDF file
                try {
                    await fs.promises.unlink(generatedPdfPath);
                    logger.info(`Deleted PDF file: ${generatedPdfPath}`);
                } catch (error) {
                    logger.error(`Error deleting PDF file ${generatedPdfPath}:`, error);
                }
            } else {
                logger.error(`PDF file not found at: ${generatedPdfPath}`);
            }

            // Clean up the temporary LaTeX file
            try {
                await fs.promises.unlink(texFilePath);
            } catch (error) {
                logger.error('Error deleting LaTeX file:', error);
            }
        } catch (error) {
            logger.error('Error compiling PDF:', error);
        }

        // Return the appropriate response based on PDF compilation success
        if (pdfSuccess && pdfContent) {
            // If PDF compilation was successful, return the PDF with LaTeX content in headers
            const response = new NextResponse(pdfContent, {
                headers: {
                    'Content-Type': 'application/pdf',
                    'Content-Disposition': `attachment; filename="${pdfFilename}"`,
                    'X-LaTeX-Filename': texFilename,
                    'X-LaTeX-Content': base64LatexContent,
                },
            });
            setProcessingStatus(false);
            return response;
        } else {
            // If PDF compilation failed, return JSON with LaTeX content
            const response = NextResponse.json({
                latexFilename: texFilename,
                latexContent: base64LatexContent,
                error: 'PDF compilation failed, but LaTeX is available for download'
            });
            setProcessingStatus(false);
            return response;
        }
    } catch (error) {
        logger.error('Error processing transcription:', error);
        // Set processing status to inactive on error
        setProcessingStatus(false);
        return NextResponse.json(
            { error: 'Failed to process transcription' },
            { status: 500 }
        );
    } finally {
        // Clean up the temporary directory
        if (tempDir && fs.existsSync(tempDir)) {
            try {
                await fsPromises.rm(tempDir, { recursive: true, force: true });
                logger.info(`Deleted temporary directory: ${tempDir}`);
            } catch (error) {
                logger.error('Error cleaning up temporary directory:', error);
            }
        }
    }
}