import { NextRequest, NextResponse } from 'next/server';
import { ElevenLabsClient } from 'elevenlabs';
import 'dotenv/config';

export async function POST(request: NextRequest) {
  try {
    // Get the API key from environment variables
    const apiKey = process.env.ELEVENLABS_API_KEY;

    if (!apiKey) {
      return NextResponse.json(
        { error: 'API key not found. Please set ELEVENLABS_API_KEY in your .env file.' },
        { status: 500 }
      );
    }

    // Initialize the ElevenLabs client
    const client = new ElevenLabsClient({
      apiKey: apiKey,
    });

    // Get the form data from the request
    const formData = await request.formData();
    const audioFile = formData.get('audio') as File;
    const languageCode = formData.get('language_code') as string || 'ita'; // Default to Italian if not provided

    if (!audioFile) {
      return NextResponse.json(
        { error: 'No audio file provided' },
        { status: 400 }
      );
    }

    // Convert the file to a Blob
    const bytes = await audioFile.arrayBuffer();
    const audioBlob = new Blob([bytes], { type: audioFile.type });

    // Make the request to the 11Labs API using the client
    const transcription = await client.speechToText.convert({
      file: audioBlob,
      model_id: "scribe_v1", // Model to use
      tag_audio_events: true, // Tag audio events like laughter, applause, etc.
      language_code: languageCode, // Language of the audio file from the request
      diarize: true, // Whether to annotate who is speaking
      num_speakers: 1,
    });

    // Return the transcription result
    return NextResponse.json(transcription);
  } catch (error) {
    console.error('Error in transcription API:', error);
    return NextResponse.json(
      { error: 'Failed to transcribe audio. Please check your API key and try again.' },
      { status: 500 }
    );
  }
} 