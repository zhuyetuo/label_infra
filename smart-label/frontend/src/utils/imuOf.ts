// 样本编号统一带 _imu{N} 后缀（multicam_20260902_101512916_imu3），一个编号 = 一只狗身上
// 的那个设备。页面里按 imu 归成"目录"看每只狗的情况用这个取编号，取不到归到"其它"。
export const IMU_OTHER = "其它";

export function imuOf(sampleCode: string | undefined | null): string {
  const m = /_imu(\d+)$/i.exec(sampleCode ?? "");
  return m ? `imu${m[1]}` : IMU_OTHER;
}

/** imu1, imu2, ..., 其它 这样排序 */
export function sortImuKeys(keys: Iterable<string>): string[] {
  return [...keys].sort((a, b) => {
    if (a === IMU_OTHER) return 1;
    if (b === IMU_OTHER) return -1;
    return Number(a.slice(3)) - Number(b.slice(3));
  });
}
