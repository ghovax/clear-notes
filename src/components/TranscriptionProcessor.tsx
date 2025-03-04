"use client"

import { useState, useCallback, useEffect } from 'react';
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
  const [latexUrl, setLatexUrl] = useState<string | null>(null);
  const [latexFilename, setLatexFilename] = useState<string | null>(null);

  // Cleanup effect to revoke object URLs when the component unmounts
  useEffect(() => {
    return () => {
      if (pdfUrl) {
        URL.revokeObjectURL(pdfUrl);
      }
      if (latexUrl) {
        URL.revokeObjectURL(latexUrl);
      }
    };
  }, [pdfUrl, latexUrl]);

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
      setLatexUrl(null);

      // Create a FormData object to send the file
      const formData = new FormData();
      formData.append('transcription', file);
      
      // Get the language from the JSON file
      const jsonData = await file.text();
      const data = JSON.parse(jsonData);
      const language = data.language_code;
      formData.append('language', language);
      
      // Check if the browser supports EventSource
      const supportsEventSource = 'EventSource' in window;
      
      if (supportsEventSource) {
        // Use streaming approach with EventSource
        formData.append('stream', 'true');
        
        try {
          // Make a direct POST request with the stream parameter
          const response = await fetch('/api/process-transcription', {
            method: 'POST',
            body: formData,
          });
          
          if (!response.ok) {
            throw new Error(`Server responded with ${response.status}: ${response.statusText}`);
          }
          
          // Check if we got a streaming response
          if (response.headers.get('Content-Type')?.includes('text/event-stream')) {
            console.log('Got streaming response, setting up reader');
            
            // Set up a reader for the response body
            const reader = response.body?.getReader();
            if (!reader) {
              throw new Error('Failed to get reader from response');
            }
            
            // Create a text decoder
            const decoder = new TextDecoder();
            let buffer = '';
            
            // Read the stream
            while (true) {
              const { done, value } = await reader.read();
              if (done) {
                console.log('Stream complete');
                break;
              }
              
              // Decode the chunk and add it to our buffer
              buffer += decoder.decode(value, { stream: true });
              
              // Process any complete messages in the buffer
              const messages = buffer.split('\n\n');
              buffer = messages.pop() || ''; // Keep the last incomplete message in the buffer
              
              for (const message of messages) {
                if (!message.trim()) continue;
                
                // Extract the data part
                const dataMatch = message.match(/^data: (.+)$/m);
                if (!dataMatch) continue;
                
                try {
                  const data = JSON.parse(dataMatch[1]);
                  console.log('Received SSE data:', data);
                  
                  // Handle progress updates
                  if (data.progress !== undefined) {
                    setProgress(data.progress);
                  }
                  
                  // Handle completion
                  if (data.complete) {
                    console.log('Processing complete');
                    
                    // If PDF is available
                    if (data.pdfAvailable && data.pdfFilename) {
                      // Create a download link for the PDF from the base64 content
                      if (data.pdfContent) {
                        try {
                          const pdfBlob = new Blob([Uint8Array.from(atob(data.pdfContent), c => c.charCodeAt(0))], { type: 'application/pdf' });
                          const pdfUrl = URL.createObjectURL(pdfBlob);
                          setPdfUrl(pdfUrl);
                          setPdfFilename(data.pdfFilename);
                          console.log('PDF blob created successfully');
                        } catch (error) {
                          console.error('Error creating PDF blob:', error);
                          setError('Error creating PDF download. Please try again.');
                        }
                      } else {
                        console.error('PDF content not provided in streaming response');
                        setError('PDF content not provided. Please try again.');
                      }
                    }
                    
                    // Handle LaTeX content
                    if (data.latexContent && data.latexFilename) {
                      try {
                        const latexBlob = new Blob([Uint8Array.from(atob(data.latexContent), c => c.charCodeAt(0))], { type: 'application/x-latex' });
                        const latexUrl = URL.createObjectURL(latexBlob);
                        setLatexUrl(latexUrl);
                        setLatexFilename(data.latexFilename);
                        console.log('LaTeX blob created successfully');
                      } catch (error) {
                        console.error('Error creating LaTeX blob:', error);
                        setError('Error creating LaTeX download. Please try again.');
                      }
                    } else if (data.complete) {
                      console.error('LaTeX content not provided in streaming response');
                      setError('LaTeX content not provided. Please try again.');
                    }
                    
                    setIsProcessing(false);
                    setProgress(100);
                  }
                  
                  // Handle errors
                  if (data.error) {
                    setError(data.error);
                    setIsProcessing(false);
                  }
                } catch (error) {
                  console.error('Error parsing SSE message:', error);
                }
              }
            }
          } else {
            // Handle non-streaming response (fallback)
            console.log('Got non-streaming response');
            const contentType = response.headers.get('Content-Type');
            
            if (contentType?.includes('application/pdf')) {
              // Handle PDF response
              const pdfBlob = await response.blob();
              const pdfUrl = URL.createObjectURL(pdfBlob);
              setPdfUrl(pdfUrl);
              
              // Get the PDF filename from the response headers
              const contentDisposition = response.headers.get('Content-Disposition');
              let pdfFilename = 'processed-transcription.pdf';
              if (contentDisposition) {
                const filenameMatch = contentDisposition.match(/filename="(.+)"/);
                if (filenameMatch && filenameMatch[1]) {
                  pdfFilename = filenameMatch[1];
                }
              }
              setPdfFilename(pdfFilename);
              
              // Get the LaTeX content and filename from the response
              const latexContent = response.headers.get('X-LaTeX-Content');
              const latexFilename = response.headers.get('X-LaTeX-Filename');
              
              if (latexContent && latexFilename) {
                try {
                  const latexBlob = new Blob([Uint8Array.from(atob(latexContent), c => c.charCodeAt(0))], { type: 'application/x-latex' });
                  const latexUrl = URL.createObjectURL(latexBlob);
                  setLatexUrl(latexUrl);
                  setLatexFilename(latexFilename);
                  console.log('LaTeX blob created successfully');
                } catch (error) {
                  console.error('Error creating LaTeX blob:', error);
                  setError('Error creating LaTeX download. Please try again.');
                }
              }
            } else if (contentType?.includes('application/json')) {
              // Handle JSON response (likely an error or LaTeX-only response)
              const responseData = await response.json();
              
              if (responseData.error) {
                setError(responseData.error);
              }
              
              if (responseData.latexContent && responseData.latexFilename) {
                try {
                  const latexBlob = new Blob([Uint8Array.from(atob(responseData.latexContent), c => c.charCodeAt(0))], { type: 'application/x-latex' });
                  const latexUrl = URL.createObjectURL(latexBlob);
                  setLatexUrl(latexUrl);
                  setLatexFilename(responseData.latexFilename);
                  console.log('LaTeX blob created successfully');
                } catch (error) {
                  console.error('Error creating LaTeX blob:', error);
                  setError('Error creating LaTeX download. Please try again.');
                }
              }
            } else {
              throw new Error(`Unexpected response content type: ${contentType}`);
            }
          }
          
          setProgress(100);
          setIsProcessing(false);
        } catch (error: any) {
          console.error('Error processing transcription:', error);
          setError(`Failed to process transcription: ${error.message}`);
          setIsProcessing(false);
        }
      } else {
        // Fallback to non-streaming approach
        // Start a polling interval to check progress
        const pollInterval = 2000; // 2 seconds
        let pollTimer: NodeJS.Timeout | null = null;
        
        // Function to poll for progress
        const pollProgress = async () => {
          try {
            const progressResponse = await fetch('/api/progress');
            if (progressResponse.ok) {
              const { progress, isProcessingActive } = await progressResponse.json();
              if (progress !== undefined) {
                // Scale progress to 10-90% range (upload is 0-10%, completion is 100%)
                const scaledProgress = 10 + (progress * 0.8);
                setProgress(Math.round(scaledProgress));
              }
              
              // If processing is no longer active, stop polling
              if (isProcessingActive === false) {
                if (pollTimer) {
                  clearInterval(pollTimer);
                  pollTimer = null;
                }
              }
            }
          } catch (error) {
            console.error('Error polling progress:', error);
          }
        };
        
        // Start polling
        pollTimer = setInterval(pollProgress, pollInterval);
        
        // Make the API request to our server-side API route
        const response = await axios.post(
          '/api/process-transcription',
          formData,
          {
            headers: {
              'Content-Type': 'multipart/form-data'
            },
            responseType: 'blob', // Important for receiving the response as a blob
            onUploadProgress: (progressEvent) => {
              if (progressEvent.total) {
                // This only tracks the upload progress, not the processing progress
                const percentCompleted = Math.round((progressEvent.loaded * 100) / progressEvent.total);
                setProgress(Math.min(10, percentCompleted)); // Cap at 10% for upload progress
              }
            }
          }
        );
        
        // Stop polling once we get the response
        if (pollTimer) {
          clearInterval(pollTimer);
        }

        // Get the content type to determine if we received a PDF or JSON
        const contentType = response.headers['content-type'];
        
        if (contentType === 'application/pdf') {
          // We received a PDF - create a URL for the PDF blob
          const pdfBlob = new Blob([response.data], { type: 'application/pdf' });
          const pdfUrl = URL.createObjectURL(pdfBlob);
          setPdfUrl(pdfUrl);
          
          // Get the PDF filename from the response headers
          const contentDisposition = response.headers['content-disposition'];
          let pdfFilename = 'processed-transcription.pdf';
          if (contentDisposition) {
            const filenameMatch = contentDisposition.match(/filename="(.+)"/);
            if (filenameMatch && filenameMatch[1]) {
              pdfFilename = filenameMatch[1];
            }
          }
          setPdfFilename(pdfFilename);
          
          // Get the LaTeX content and filename from the response
          const latexContent = response.headers['x-latex-content'];
          const latexFilename = response.headers['x-latex-filename'];
          
          if (latexContent && latexFilename) {
            // Create a URL for the LaTeX blob
            try {
              const latexBlob = new Blob([Uint8Array.from(atob(latexContent), c => c.charCodeAt(0))], { type: 'application/x-latex' });
              const latexUrl = URL.createObjectURL(latexBlob);
              setLatexUrl(latexUrl);
              setLatexFilename(latexFilename);
              console.log('LaTeX blob created successfully');
            } catch (error) {
              console.error('Error creating LaTeX blob:', error);
              setError('Error creating LaTeX download. Please try again.');
            }
          }
        } else {
          // We received JSON with error or LaTeX only
          try {
            const responseData = JSON.parse(new TextDecoder().decode(response.data));
            
            if (responseData.error) {
              setError(responseData.error);
            }
            
            if (responseData.latexContent && responseData.latexFilename) {
              // Create a URL for the LaTeX blob
              try {
                const latexBlob = new Blob([Uint8Array.from(atob(responseData.latexContent), c => c.charCodeAt(0))], { type: 'application/x-latex' });
                const latexUrl = URL.createObjectURL(latexBlob);
                setLatexUrl(latexUrl);
                setLatexFilename(responseData.latexFilename);
                console.log('LaTeX blob created successfully');
              } catch (error) {
                console.error('Error creating LaTeX blob:', error);
                setError('Error creating LaTeX download. Please try again.');
              }
            }
          } catch (error) {
            console.error('Error parsing response:', error);
            setError('Failed to process transcription. Please try again.');
          }
        }
        
        setProgress(100);
        setIsProcessing(false);
      }
    } catch (error: any) {
      console.error('Error processing transcription:', error);
      setError(`Failed to process transcription: ${error.message}`);
      setIsProcessing(false);
    }
  };

  const resetForm = () => {
    // Clean up any created object URLs
    if (pdfUrl) {
      URL.revokeObjectURL(pdfUrl);
    }
    if (latexUrl) {
      URL.revokeObjectURL(latexUrl);
    }
    
    setFile(null);
    setPdfUrl(null);
    setLatexUrl(null);
    setLatexFilename(null);
    setPdfFilename(null);
    setError(null);
  };

  return (
    <Card className="w-full max-w-full mx-auto">
      <CardHeader className="pb-2">
        <CardTitle className="text-xl">Process Transcription</CardTitle>
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
              <p className="font-md text-base break-words">{file.name}</p>
              <p className="text-sm text-muted-foreground">
                {(file.size / 1024).toFixed(2)} KB
              </p>
            </div>
          ) : (
            <div>
              <p className="text-base">Drag & drop a transcription file here, or tap to select</p>
              <p className="text-sm text-muted-foreground mt-1">
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

        {(pdfUrl || latexUrl) && !isProcessing && (
          <div className="space-y-2">
            {pdfUrl && (
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
            
            {latexUrl && (
              <Button
                asChild
                className="w-full"
                variant="outline"
              >
                <a
                  href={latexUrl}
                  download={latexFilename || 'processed-transcription.tex'}
                >
                  Download LaTeX
                </a>
              </Button>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  );
};

export default TranscriptionProcessor; 