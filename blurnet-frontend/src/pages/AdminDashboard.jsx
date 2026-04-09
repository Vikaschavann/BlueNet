import React, { useState, useEffect, useRef } from 'react';
import { ShieldAlert, ShieldCheck, ShieldBan, Activity, Users, AlertTriangle } from 'lucide-react';

export default function AdminDashboard() {
  const [metrics, setMetrics] = useState({ users: [] });
  const [isConnected, setIsConnected] = useState(false);
  const wsRef = useRef(null);

  useEffect(() => {
    const wsUrl = import.meta.env.VITE_MODERATION_WS 
       ? import.meta.env.VITE_MODERATION_WS.replace('/moderate', '/admin') 
       : 'ws://localhost:8000/ws/admin';
       
    const ws = new WebSocket(wsUrl);
    
    ws.onopen = () => setIsConnected(true);
    ws.onclose = () => setIsConnected(false);
    ws.onerror = (e) => console.error("Admin WS error:", e);
    
    ws.onmessage = (event) => {
      try {
         const data = JSON.parse(event.data);
         if (data.type === "metrics") {
             setMetrics(data.data);
         }
      } catch (e) {
          console.error("Error parsing WS admin metrics:", e);
      }
    };
    
    wsRef.current = ws;
    
    return () => {
        ws.close();
    };
  }, []);

  const totalUsers = metrics.users.length;
  const highRiskUsers = metrics.users.filter(u => u.riskScore > 0.65).length;
  const blockedUsers = metrics.users.filter(u => u.status === 'block' || u.status === 'remove').length;

  return (
    <div className="min-h-screen bg-slate-950 text-white p-8 font-sans">
      <div className="max-w-6xl mx-auto">
        <header className="flex justify-between items-center mb-8 pb-6 border-b border-slate-800">
          <div className="flex items-center gap-4">
             <div className="p-3 bg-brand-primary/20 text-brand-primary rounded-xl border border-brand-primary/30">
               <ShieldAlert className="w-8 h-8" />
             </div>
             <div>
               <h1 className="text-3xl font-bold tracking-tight text-slate-100">AI Safety Sentinel</h1>
               <p className="text-slate-400">Real-time global moderation oversight</p>
             </div>
          </div>
          
          <div className={`px-4 py-2 ${isConnected ? 'bg-emerald-500/10 text-emerald-400 border-emerald-500/20' : 'bg-red-500/10 text-red-500 border-red-500/20'} border rounded-full font-medium flex items-center gap-2`}>
            <span className={`w-2 h-2 rounded-full ${isConnected ? 'bg-emerald-500 animate-pulse' : 'bg-red-500'}`} />
            {isConnected ? 'LIVE SYNC' : 'CONNECTION LOST'}
          </div>
        </header>

        <div className="grid grid-cols-1 md:grid-cols-3 gap-6 mb-8">
          <div className="bg-slate-900 border border-slate-800 rounded-2xl p-6 shadow-lg shadow-black/50">
            <div className="flex justify-between items-start">
               <div>
                  <p className="text-slate-400 font-medium mb-1">Active Streams</p>
                  <p className="text-4xl font-bold text-white">{totalUsers}</p>
               </div>
               <div className="p-3 bg-blue-500/20 text-blue-400 rounded-lg flex items-center justify-center">
                 <Users className="w-6 h-6" />
               </div>
            </div>
          </div>

          <div className="bg-slate-900 border border-slate-800 rounded-2xl p-6 shadow-lg shadow-black/50">
            <div className="flex justify-between items-start">
               <div>
                  <p className="text-slate-400 font-medium mb-1">High Risk Detected</p>
                  <p className="text-4xl font-bold text-yellow-500">{highRiskUsers}</p>
               </div>
               <div className="p-3 bg-yellow-500/20 text-yellow-500 rounded-lg flex items-center justify-center">
                 <AlertTriangle className="w-6 h-6" />
               </div>
            </div>
          </div>

          <div className="bg-slate-900 border border-slate-800 rounded-2xl p-6 shadow-lg shadow-black/50">
            <div className="flex justify-between items-start">
               <div>
                  <p className="text-slate-400 font-medium mb-1">Blocked Entities</p>
                  <p className="text-4xl font-bold text-red-500">{blockedUsers}</p>
               </div>
               <div className="p-3 bg-red-500/20 text-red-500 rounded-lg flex items-center justify-center">
                 <ShieldBan className="w-6 h-6" />
               </div>
            </div>
          </div>
        </div>

        <div className="bg-slate-900 border border-slate-800 rounded-2xl overflow-hidden shadow-2xl">
          <table className="w-full text-left">
            <thead>
              <tr className="bg-slate-950/50 border-b border-slate-800 text-slate-400 uppercase text-xs tracking-wider">
                <th className="px-6 py-4 font-semibold">User Identifier</th>
                <th className="px-6 py-4 font-semibold">Engine Risk Score</th>
                <th className="px-6 py-4 font-semibold">Safety Violations</th>
                <th className="px-6 py-4 font-semibold">Network State</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-800/60">
              {metrics.users.length === 0 ? (
                <tr>
                   <td colSpan="4" className="px-6 py-12 text-center text-slate-500">
                     No active users in the system. Start a stream to monitor it.
                   </td>
                </tr>
              ) : (
                metrics.users.map((user) => {
                   let riskColor = 'text-green-400';
                   let riskBg = 'bg-green-400/10 border-green-400/20';
                   let StatusIcon = ShieldCheck;
                   
                   if (user.riskScore > 0.8) {
                      riskColor = 'text-red-500';
                      riskBg = 'bg-red-500/10 border-red-500/20';
                      StatusIcon = ShieldBan;
                   } else if (user.riskScore > 0.45) {
                      riskColor = 'text-yellow-500';
                      riskBg = 'bg-yellow-500/10 border-yellow-500/20';
                      StatusIcon = AlertTriangle;
                   }
                   
                   return (
                     <tr key={user.id} className="hover:bg-slate-800/30 transition">
                       <td className="px-6 py-4">
                         <div className="font-mono text-sm text-slate-300">{user.id}</div>
                       </td>
                       <td className="px-6 py-4">
                         <div className={`inline-flex items-center gap-2 px-3 py-1 rounded-full border ${riskBg} ${riskColor}`}>
                           <Activity className="w-4 h-4" />
                           <span className="font-bold">{(user.riskScore * 100).toFixed(1)}%</span>
                         </div>
                       </td>
                       <td className="px-6 py-4">
                         <div className="flex gap-1">
                           {[...Array(5)].map((_, i) => (
                              <div key={i} className={`w-2 h-6 rounded-sm ${i < user.violations ? 'bg-red-500 shadow-[0_0_8px_rgba(239,68,68,0.5)]' : 'bg-slate-800'}`} />
                           ))}
                           {user.violations > 5 && <span className="ml-2 text-red-500 font-bold">+{user.violations - 5}</span>}
                         </div>
                       </td>
                       <td className="px-6 py-4">
                         <div className="flex items-center gap-2 uppercase tracking-wide text-xs font-bold text-slate-300">
                           <StatusIcon className={`w-5 h-5 ${riskColor}`} />
                           {user.status}
                         </div>
                       </td>
                     </tr>
                   );
                })
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
