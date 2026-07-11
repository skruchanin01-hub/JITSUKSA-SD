# ข้อจำกัดของ V3 Firebase Zero-Budget

1. ไม่ใช่ระบบยืนยันตัวตนนักเรียน 100% เพราะนักเรียนใช้ Anonymous Auth
2. นักเรียนที่แกะโค้ดเป็นอาจพยายามส่งข้อมูลปลอมได้ แต่ Security Rules ช่วยกันการแก้/ลบ/ส่งนอกเวลา
3. ถ้าต้องการเข้มขึ้น ต้องใช้บัญชีโรงเรียน หรือเก็บ roster ใน Firestore เพื่อให้ rules ตรวจ
4. Dashboard summary จะอัปเดตเมื่อ Admin กด Refresh หรือ Auto refresh เท่านั้น
5. Google Sheets ไม่ใช่ฐานหลัก ต้อง Export CSV เอง
6. ถ้าใช้เกิน quota Spark plan ระบบอาจหยุดจนกว่า quota reset
7. ไม่ควรใช้ Cloud Storage เก็บเสียง/รูป หากต้องการคุม 0 บาท
8. ไม่ควรใช้ SMS OTP เพราะมีค่าใช้จ่าย
9. หน้าเด็กต้องไม่ใช้ realtime listener ค้างไว้
10. ถ้านักเรียนเปิดผ่าน in-app browser อาจใช้ไมค์ไม่ได้ ต้องใช้ Chrome/Safari
