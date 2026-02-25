import React from 'react'
import VideoCall from './components/VideoCall'

function App() {
    return (
        <div className="min-h-screen bg-zinc-950 text-white font-sans selection:bg-indigo-500/30">
            <header className="p-6 border-b border-white/5 bg-zinc-900/50 backdrop-blur-xl">
                <h1 className="text-2xl font-bold bg-gradient-to-r from-indigo-400 to-cyan-400 bg-clip-text text-transparent">
                    BlurNet AI Moderation
                </h1>
            </header>
            <main className="container mx-auto p-6">
                <VideoCall />
            </main>
        </div>
    )
}

export default App
