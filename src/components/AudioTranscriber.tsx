"use client";

import { useState, useCallback } from 'react';
import { useDropzone } from 'react-dropzone';
import axios from 'axios';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle, CardFooter } from '@/components/ui/card';
import { Progress } from '@/components/ui/progress';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Input } from '@/components/ui/input';

interface TranscriptionResult {
  language_code?: string;
  language_probability?: number;
  text: string;
  words?: Array<{
    text: string;
    start?: number;
    end?: number;
    type?: 'word' | 'spacing' | 'audio_event';
    speaker_id?: string;
  }>;
  audio_events?: Array<{
    type: string;
    start_time: number;
    end_time: number;
  }>;
  speakers?: Array<{
    name: string;
    segments: Array<{
      start_time: number;
      end_time: number;
      text: string;
    }>;
  }>;
}

const AudioTranscriber = () => {
  const [file, setFile] = useState<File | null>(null);
  const [isTranscribing, setIsTranscribing] = useState<boolean>(false);
  const [progress, setProgress] = useState<number>(0);
  const [result, setResult] = useState<TranscriptionResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isLongTranscription, setIsLongTranscription] = useState<boolean>(false);
  const [savedFileName, setSavedFileName] = useState<string | null>(null);
  const [languageCode, setLanguageCode] = useState<string>("ita"); // Default to Italian

  const onDrop = useCallback((acceptedFiles: File[]) => {
    if (acceptedFiles.length > 0) {
      const selectedFile = acceptedFiles[0];
      setFile(selectedFile);
      setResult(null); // Clear previous results when a new file is selected
    }
  }, []);

  const { getRootProps, getInputProps, isDragActive } = useDropzone({
    onDrop,
    accept: {
      'audio/*': ['.mp3', '.wav', '.m4a', '.aac', '.ogg', '.flac']
    },
    maxFiles: 1
  });

  const transcribeAudio = async () => {
    if (!file) return;

    try {
      setIsTranscribing(true);
      setProgress(0);
      setError(null);
      setIsLongTranscription(false);
      setSavedFileName(null);

      // Create a FormData object to send the file
      const formData = new FormData();
      formData.append('audio', file);
      formData.append('language_code', languageCode);

      // Make the API request to our server-side API route
      const response = await axios.post(
        '/api/transcribe',
        formData,
        {
          headers: {
            'Content-Type': 'multipart/form-data'
          },
          onUploadProgress: (progressEvent) => {
            if (progressEvent.total) {
              const percentCompleted = Math.round((progressEvent.loaded * 100) / progressEvent.total);
              setProgress(percentCompleted);
            }
          }
        }
      );

      setResult(response.data);

      // Check if transcription is longer than 100 words
      // Count only actual words, not spacing or audio_events
      let wordCount = 0;

      if (response.data.words && response.data.words.length > 0) {
        wordCount = response.data.words.filter((item: { type?: string }) => item.type === 'word').length;
      } else {
        // Fallback to splitting the text if words array is not available
        wordCount = response.data.text.split(/\s+/).filter(Boolean).length;
      }

      const isLong = wordCount > 100;
      setIsLongTranscription(isLong);

      // Save the result to a file
      if (response.data) {
        const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
        const fileName = file.name.replace(/\.[^/.]+$/, ''); // Remove extension
        const resultFileName = `${fileName}_transcription_${timestamp}.json`;
        setSavedFileName(resultFileName);

        // Create a downloadable blob
        const blob = new Blob([JSON.stringify(response.data, null, 2)], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const link = document.createElement('a');
        link.href = url;
        link.download = resultFileName;
        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);
        URL.revokeObjectURL(url);
      }
    } catch (err: any) {
      console.error('Error transcribing audio:', err);
      setError(err.response?.data?.error || 'Failed to transcribe audio. Please try again.');
    } finally {
      setIsTranscribing(false);
      setProgress(100);
    }
  };

  return (
    <Card className="w-full max-w-full mx-auto">
      <CardHeader className="pb-2">
        <CardTitle className="text-xl">Audio Transcription</CardTitle>
      </CardHeader>

      <CardContent className="space-y-4">
        <div
          {...getRootProps()}
          className={`border-2 border-dashed rounded-lg p-3 cursor-pointer transition-colors min-h-[80px] flex items-center justify-center ${isDragActive ? 'border-primary bg-primary/10' : 'border-muted'
            }`}
        >
          <input {...getInputProps()} />
          {file ? (
            <div>
              <p className="font-medium text-md break-words">{file.name}</p>
              <p className="text-sm text-muted-foreground">
                {(file.size / 1024 / 1024).toFixed(2)} MB
              </p>
            </div>
          ) : (
            <div>
              <p className="text-md">Drag & drop an audio file here, or tap to select</p>
              <p className="text-sm text-muted-foreground mt-1">
                Supported formats: MP3, WAV, M4A, AAC, OGG, FLAC
              </p>
            </div>
          )}
        </div>

        <div className="space-y-2">
          <label htmlFor="language-code" className="text-md font-medium">
            Language Code
          </label>
          <Input
            id="language-code"
            type="text"
            value={languageCode}
            onChange={(e) => setLanguageCode(e.target.value)}
            placeholder="Enter language code (e.g., ita, eng, fra)"
          />
          <p className="text-sm text-muted-foreground">
            Common codes: eng (English), ita (Italian), fra (French), deu (German), spa (Spanish)
          </p>
        </div>

        {file && (
          <Button
            onClick={transcribeAudio}
            disabled={isTranscribing}
            className="w-full"
          >
            {isTranscribing ? 'Transcribing...' : 'Transcribe audio'}
          </Button>
        )}

        {isTranscribing && (
          <div className="space-y-1">
            <Progress value={progress} className="w-full h-2" />
            <p className="text-sm text-left">{progress}% complete</p>
          </div>
        )}

        {error && (
          <Alert variant="destructive">
            <AlertDescription className="text-md">
              {error}
            </AlertDescription>
          </Alert>
        )}
      </CardContent>
    </Card>
  );
};

export default AudioTranscriber; 