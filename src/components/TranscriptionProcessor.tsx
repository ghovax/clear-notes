"use client"

import { useState, useCallback } from 'react';
import { useDropzone } from 'react-dropzone';
import axios from 'axios';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle, CardFooter } from '@/components/ui/card';
import { Progress } from '@/components/ui/progress';
import { Alert, AlertDescription } from '@/components/ui/alert';

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

const TranscriptionProcessor = () => {
  const [file, setFile] = useState<File | null>(null);
  const [isProcessing, setIsProcessing] = useState(false);
  const [progress, setProgress] = useState<number>(0);
  const [error, setError] = useState<string | null>(null);
  const [pdfUrl, setPdfUrl] = useState<string | null>(null);
  const [pdfFilename, setPdfFilename] = useState<string | null>(null);

  const onDrop = useCallback((acceptedFiles: File[]) => {
    if (acceptedFiles.length > 0) {
      const selectedFile = acceptedFiles[0];
      setFile(selectedFile);
      setPdfUrl(null);
      setError(null);
    }
  }, []);

  const { getRootProps, getInputProps, isDragActive } = useDropzone({
    onDrop,
    accept: {
      'application/json': ['.json']
    },
    maxFiles: 1
  });

  const processTranscription = async () => {
    if (!file) return;

    try {
      setIsProcessing(true);
      setProgress(0);
      setError(null);
      setPdfUrl(null);

      // Create a FormData object to send the file
      const formData = new FormData();
      formData.append('transcription', file);
      // Get the language from the JSON file
      const jsonData = await file.text();
      const data = JSON.parse(jsonData);
      const language = data.language_code;
      formData.append('language', language);
      
      // Make the API request to our server-side API route
      const response = await axios.post(
        '/api/process-transcription',
        formData,
        {
          headers: {
            'Content-Type': 'multipart/form-data'
          },
          responseType: 'blob', // Important for receiving the PDF file
        }
      );

      // Create a URL for the PDF blob
      const pdfBlob = new Blob([response.data], { type: 'application/pdf' });
      const url = URL.createObjectURL(pdfBlob);

      // Get the filename from the response headers if available
      const contentDisposition = response.headers['content-disposition'];
      let filename = 'processed-transcription.pdf';

      if (contentDisposition) {
        const filenameMatch = contentDisposition.match(/filename="(.+)"/);
        if (filenameMatch && filenameMatch[1]) {
          filename = filenameMatch[1];
        }
      }

      setPdfUrl(url);
      setPdfFilename(filename);
      setProgress(100);
    } catch (err) {
      console.error('Error processing transcription:', err);
      setError('Failed to process transcription. Please try again.');
    } finally {
      setIsProcessing(false);
    }
  };

  const resetForm = () => {
    setFile(null);
    setPdfUrl(null);
    setError(null);
  };

  return (
    <Card className="w-full max-w-full mx-auto">
      <CardHeader className="pb-2">
        <CardTitle className="text-md sm:text-lg md:text-xl lg:text-2xl">Process Transcription</CardTitle>
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
              <p className="font-medium text-md sm:text-md md:text-md lg:text-lg break-words">{file.name}</p>
              <p className="text-md sm:text-md md:text-md lg:text-md text-muted-foreground">
                {(file.size / 1024).toFixed(2)} KB
              </p>
            </div>
          ) : (
            <div>
              <p className="text-md sm:text-md md:text-md lg:text-lg">Drag & drop a transcription file here, or tap to select</p>
              <p className="text-md sm:text-md md:text-md lg:text-md text-muted-foreground mt-1">
                Supported format: JSON
              </p>
            </div>
          )}
        </div>

        {file && (
          <Button
            onClick={processTranscription}
            disabled={isProcessing}
            className="w-full"
          >
            {isProcessing ? 'Processing...' : 'Process Transcription'}
          </Button>
        )}

        {isProcessing && (
          <div className="space-y-1">
            <Progress value={progress} className="w-full h-2" />
            <p className="text-md sm:text-md md:text-md lg:text-md text-left">{progress}% complete</p>
          </div>
        )}

        {error && (
          <Alert variant="destructive">
            <AlertDescription className="text-md sm:text-md md:text-md lg:text-md">
              {error}
            </AlertDescription>
          </Alert>
        )}

        {pdfUrl && !isProcessing && (
          <Button
            asChild
            className="w-full"
            variant="outline"
          >
            <a
              href={pdfUrl}
              download={pdfFilename || 'processed-transcription.pdf'}
            >
              Download PDF
            </a>
          </Button>
        )}
      </CardContent>
    </Card>
  );
};

export default TranscriptionProcessor; 