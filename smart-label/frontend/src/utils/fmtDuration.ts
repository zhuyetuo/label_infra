/** 时长给人看：14 小时 49 分 / 3 分 20 秒 / 45 秒。一律拆成两级整数——
 *  只写秒（53312 秒）看不出多长，写小数（14.8 小时）又得心算 0.8 小时是几分 */
export const fmtSecs = (sec: number) => {
  const t = Math.round(sec);
  if (t >= 3600) {
    const h = Math.floor(t / 3600);
    const m = Math.floor((t % 3600) / 60);
    return m ? `${h} 小时 ${m} 分` : `${h} 小时`;
  }
  if (t >= 60) {
    const m = Math.floor(t / 60);
    const s2 = t % 60;
    return s2 ? `${m} 分 ${s2} 秒` : `${m} 分`;
  }
  return `${t} 秒`;
};
