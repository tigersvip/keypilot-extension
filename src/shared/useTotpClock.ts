import { useEffect, useState } from 'react';

export function useTotpClock() {
  const [now,setNow] = useState(Date.now());
  useEffect(()=>{
    let timer: number | undefined;
    const update = () => {
      window.clearInterval(timer);
      if (!document.hidden) {setNow(Date.now());timer=window.setInterval(()=>setNow(Date.now()),1000);}
    };
    update();document.addEventListener('visibilitychange',update);window.addEventListener('focus',update);
    return ()=>{window.clearInterval(timer);document.removeEventListener('visibilitychange',update);window.removeEventListener('focus',update);};
  },[]);
  return now;
}
