import Image from "next/image";
import AudioTranscriber from "../components/AudioTranscriber";
import TranscriptionProcessor from "../components/TranscriptionProcessor";

export default function Home() {
  return (
    <div className="grid grid-rows-[auto_1fr_auto] items-center justify-items-center min-h-screen p-8 pb-20 gap-8 sm:p-30 font-[family-name:var(--font-geist-sans)] text-base md:text-md lg:text-lg">
      <header className="w-full flex justify-center items-center py-4">
        <h1 className="text-4xl font-bold">ClearNotes</h1>
      </header>

      <main className="w-full max-w-8xl flex flex-col gap-8 items-center">
        <AudioTranscriber />
        <TranscriptionProcessor />
      </main>

      <footer className="w-full flex justify-center items-center py-4 text-sm md:text-base text-gray-500">
        <p>Powered by ElevenLabs API</p>
      </footer>
    </div>
  );
}
