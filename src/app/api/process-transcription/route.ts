import { NextRequest, NextResponse } from 'next/server';
import { writeFile, mkdir, readFile, unlink } from 'fs/promises';
import { exec } from 'child_process';
import { promisify } from 'util';
import path from 'path';
import { existsSync } from 'fs';
import { v4 as uuidv4 } from 'uuid';
import { GoogleGenerativeAI, HarmCategory, HarmBlockThreshold, SchemaType } from "@google/generative-ai";
import unidecode from 'unidecode';

const execPromise = promisify(exec);

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

// Process the transcription JSON
function processTranscription(transcriptionData: any): string[] {
    // Extract only words from speaker_0, filtering out audio events
    const filteredWords = transcriptionData.words?.filter(
        (item: any) => item.type !== 'audio_event' // && item.speaker_id === 'speaker_0'
    ) || [];

    // Combine the filtered words into a single text
    let fullText = filteredWords
        .map((item: any) => item.text)
        .join('');

    // Remove all non-ASCII characters
    fullText = unidecode(fullText);

    // Improved sentence splitting algorithm that handles various edge cases:
    // 1. Triple dots (...) - should not split sentences
    // 2. Common abbreviations (Mr., Dr., etc.) - should not split sentences
    // 3. Quoted sentences - should maintain proper boundaries
    // 4. Parenthetical statements - should maintain proper boundaries

    // First, temporarily replace patterns we don't want to split on
    let processedText = fullText
        // Handle ellipsis (triple dots) - replace with a placeholder
        .replace(/\.{3,}/g, '___ELLIPSIS___')
        // Handle common abbreviations
        .replace(/\b(Mr|Mrs|Ms|Dr|Prof|Inc|Ltd|Co|St|Ave|Blvd|Rd|Hwy|Fig|Eq)\./g, '$1___ABBR___')
        // Handle common numeric patterns (e.g., 3.14, 1.5, etc.)
        .replace(/\b\d+\.\d+/g, (match: string) => match.replace('.', '___DECIMAL___'));

    // Now split on actual sentence boundaries
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
    const paragraphs: string[] = [];
    const sentencesPerParagraph = 6;

    for (let i = 0; i < sentences.length; i += sentencesPerParagraph) {
        const paragraph = sentences
            .slice(i, i + sentencesPerParagraph)
            .join(' ');

        if (paragraph.trim().length > 0) {
            paragraphs.push(paragraph);
        }
    }

    return paragraphs;
}

// Process paragraphs through Gemini API
async function processParagraphsWithGemini(
    paragraphs: string[],
    setProgress: (progress: number) => void,
    language: string
): Promise<{ text: string, footnotes: Map<number, string[]> }> {
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) {
        console.error("GEMINI_API_KEY environment variable is not set");
        // Return original paragraphs if API key is not set
        return {
            text: paragraphs.join('\n'),
            footnotes: new Map()
        };
    }

    try {
        const genAI = new GoogleGenerativeAI(apiKey);

        // Set up the chat session with JSON response format
        const processedParagraphs: string[] = [];
        const paragraphFootnotes = new Map<number, string[]>();
        let messageCount = 0;
        const model = genAI.getGenerativeModel({
            model: "gemini-2.0-flash",
            generationConfig: {
                temperature: 0.1,
                topP: 0.95,
                topK: 20,
                maxOutputTokens: 8192,
                responseMimeType: "application/json",
                responseSchema: {
                    type: SchemaType.OBJECT,
                    properties: {
                        reflowed_text: { type: SchemaType.STRING },
                        unknown_words: { type: SchemaType.ARRAY, items: { type: SchemaType.STRING } },
                        failed_to_reflow: { type: SchemaType.BOOLEAN }
                    },
                    required: ["reflowed_text", "failed_to_reflow"]
                },
            },
            systemInstruction: `You must strictly rephrase the given lesson excerpt for absolute clarity while preserving every detail of its original meaning. No information may be added or removed—your sole task is to refine the wording for maximum precision and professionalism. Treat it as if someone spoke unclearly, and you are making their message perfectly understandable. Ignore any irrelevant parts, such as unrelated speech from others that may have been accidentally captured in the transcript. If mathematical formulas are present, you must rewrite them correctly using LaTeX. Your output must be in LaTeX format but limited to a single paragraph, not a full LaTeX document. The text must remain in its original language: ${getLanguageDisplayName(language)}. What you return needs to be actual LaTeX code that can potentially be correctly compiled, so make sure you write it in a way that is LaTeX-compatible.`,
        });

        // Process paragraphs with rate limiting (max 10 requests per minute)
        for (let i = 0; i < paragraphs.length; i++) {
            // Update progress
            const progress = Math.round(((i + 1) / paragraphs.length) * 100);
            setProgress(progress);

            // Reset chat session every 10 messages
            if (messageCount >= 10) {
                messageCount = 0;
                // Wait a bit to ensure we don't exceed rate limits
                // Log the progress at the current time, hours, minutes and seconds with timezone
                const now = new Date();
                const hours = now.getHours();
                const minutes = now.getMinutes();
                const seconds = now.getSeconds();
                const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
                console.log(`Processed ${i + 1} of ${paragraphs.length} paragraphs at ${progress}% (${hours}:${minutes}:${seconds} ${timezone})`);
                await new Promise(resolve => setTimeout(resolve, 60000));
            }

            try {
                // Request JSON format in the prompt
                const prompt = paragraphs[i];

                const result = await model.generateContent(prompt);
                const responseText = result.response.text();

                // Parse the JSON response
                let parsedResponse;
                try {
                    parsedResponse = JSON.parse(responseText);
                } catch (e) {
                    console.error("Failed to parse JSON response:", e);
                    console.error("Raw response for reference:", responseText);

                    // If response is not valid JSON, try to extract JSON from the text
                    const jsonMatch = responseText.match(/\{[\s\S]*\}/);
                    if (jsonMatch) {
                        try {
                            parsedResponse = JSON.parse(jsonMatch[0]);
                            console.log("Successfully extracted JSON from response");
                        } catch (e2) {
                            console.error("Failed to parse JSON from extracted match:", e2);
                            parsedResponse = { reflowed_text: paragraphs[i], unknown_words: [] };
                        }
                    } else {
                        console.error("Response is not valid JSON and couldn't extract JSON");
                        parsedResponse = { reflowed_text: paragraphs[i], unknown_words: [] };
                    }
                }

                const reflowedText = parsedResponse.reflowed_text || paragraphs[i];
                const unknownWords = parsedResponse.unknown_words || [];
                const failedToReflow = parsedResponse.failed_to_reflow || false;

                if (failedToReflow) {
                    console.error(`Failed to reflow paragraph ${i + 1}`);
                    processedParagraphs.push(paragraphs[i]);
                } else if (unknownWords.length > 0) {
                    paragraphFootnotes.set(i, unknownWords);
                    processedParagraphs.push(reflowedText); // Add reflowed text even if there are unknown words
                    messageCount++;
                } else {
                    processedParagraphs.push(reflowedText);
                    messageCount++;
                }
            } catch (error) {
                console.error(`Error processing paragraph ${i + 1}:`, error);
                // If there's an error, use the original paragraph
                processedParagraphs.push(paragraphs[i]);
            }
        }

        return {
            text: processedParagraphs.join('\n'),
            footnotes: paragraphFootnotes
        };
    } catch (error) {
        console.error("Error initializing Gemini API:", error);
        // Return original paragraphs if there's an error with the API
        return {
            text: paragraphs.join('\n'),
            footnotes: new Map()
        };
    }
}

// Escape special LaTeX characters such as %, #, etc.
function escapeLatex(text: string): string {
    return text.replace(/%/g, '\\%').replace(/#/g, '\\#');
}

// Generate LaTeX document
function generateLatexDocument(text: string, footnotes: Map<number, string[]> = new Map(), failedToReflow: boolean): string {
    // Split the text into paragraphs
    const paragraphs = text.split('\n');

    // Add footnotes to each paragraph
    const paragraphsWithFootnotes = paragraphs.map((paragraph, index) => {
        const unknownWords = footnotes.get(index);
        if (unknownWords && unknownWords.length > 0) {
            const footnoteText = unknownWords.map(word => escapeLatex(word)).join(', ');
            return `${paragraph}\\footnote{${failedToReflow ? 'Failed to reflow paragraph. ' : ''}Unknown words in paragraph: ${footnoteText}}`;
        }
        return paragraph;
    });

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
\\usepackage[autostyle, english = american]{csquotes}
\\MakeOuterQuote{"}
\\setlength{\\parindent}{1em}

\\title{}
\\author{ClearNotes}
\\date{\\today}

\\begin{document}
\\maketitle
\\begin{spacing}{1}
${paragraphsWithFootnotes.join('\n')}
\\end{spacing}
\\end{document}`;
}

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
    try {
        // Ensure directories exist
        const { artifactsDir, pdfArtifactsDir } = await ensureDirectories();

        // Parse the form data
        const formData = await request.formData();
        const transcriptionFile = formData.get('transcription') as File;
        const language = formData.get('language') as string || 'eng'; // Default to English if not provided

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

        // Process paragraphs through Gemini API.  Pass in a dummy setProgress function.
        const { text: processedText, footnotes } = await processParagraphsWithGemini(paragraphs, () => { }, language);

        // Generate LaTeX document
        // TODO: Add an actual flag to determine if the text was failed to reflow!
        const latexContent = generateLatexDocument(processedText, footnotes, false);

        // Generate a unique ID (max 10 chars)
        const uniqueId = uuidv4().replace(/-/g, '').substring(0, 10);
        const now = new Date();
        const datePart = now.toISOString().replace(/[:\-]/g, '').split('.')[0];
        const baseFilename = transcriptionFile.name.replace(/\.[^/.]+$/, ""); // Remove existing extension
        const texFilename = `${baseFilename}_${datePart}.tex`;
        const pdfFilename = `${baseFilename}_${datePart}.pdf`;

        // Write the LaTeX file
        const texFilePath = path.join(artifactsDir, texFilename);
        await writeFile(texFilePath, latexContent);

        const { stdout, stderr } = await execPromise(`./tectonic ${texFilePath}`);
        if (stderr) {
            console.error(`stderr: ${stderr}`);
        }
        console.log(`stdout: ${stdout}`);

        // Move the PDF to pdf_artifacts directory
        const generatedPdfPath = path.join(process.cwd(), pdfFilename);
        const finalPdfPath = path.join(pdfArtifactsDir, pdfFilename);

        // Read the generated PDF
        const pdfContent = await readFile(finalPdfPath);

        // Write to the final location
        await writeFile(finalPdfPath, pdfContent);

        const response = new NextResponse(pdfContent, {
            headers: {
                'Content-Type': 'application/pdf',
                'Content-Disposition': `attachment; filename="${pdfFilename}"`,
            },
        });

        // Return the PDF file
        return response;
    } catch (error) {
        console.error('Error processing transcription:', error);
        return NextResponse.json(
            { error: 'Failed to process transcription' },
            { status: 500 }
        );
    }
} 