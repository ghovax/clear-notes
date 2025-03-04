import { NextResponse } from 'next/server';

// Store the global progress in memory
// In a production app, this would be stored in a database or Redis
let globalProgress = 0;
let isProcessingActive = false;

// Function to update the global progress
export function updateGlobalProgress(progress: number) {
  globalProgress = progress;
}

// Function to set the processing status
export function setProcessingStatus(isActive: boolean) {
  isProcessingActive = isActive;
}

// API route to get the current progress
export async function GET() {
  return NextResponse.json({ 
    progress: globalProgress,
    isProcessingActive: isProcessingActive 
  });
} 