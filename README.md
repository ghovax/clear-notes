# ClearNotes

This application uses the ElevenLabs API to transcribe audio files to text and Google's Gemini API to enhance the quality of transcriptions.

## Features

- Audio transcription using ElevenLabs API
- Text enhancement and refinement using Google's Gemini API
- LaTeX document generation from transcriptions
- Automatic footnoting of unknown or specialized terms

## Setup

1. Clone the repository
2. Install dependencies with `npm install`
3. Create a `.env.local` file with the following variables:
   ```
   ELEVENLABS_API_KEY=your_elevenlabs_api_key
   GEMINI_API_KEY=your_gemini_api_key
   ```
4. Get your API keys:
   - ElevenLabs API key: https://elevenlabs.io/
   - Gemini API key: https://ai.google.dev/

## How It Works

1. Audio files are transcribed using the ElevenLabs API
2. The transcription is processed to extract meaningful text
3. Each paragraph is sent to the Gemini API for enhancement and refinement
4. Unknown or specialized terms are identified and added as footnotes
5. A LaTeX document is generated with the enhanced text and footnotes
6. The LaTeX document is compiled into a PDF

## License

This project is licensed under the MIT License - see the LICENSE file for details.
