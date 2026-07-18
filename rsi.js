name: Execute RSI Bot From External Cron

on:
  # Mở cổng nhận tín hiệu trigger kích hoạt từ trang web cron-job.org bên ngoài
  workflow_dispatch:

jobs:
  run-rsi-bot:
    runs-on: ubuntu-latest
    steps:
      - name: Checkout mã nguồn từ Repository
        uses: actions/checkout@v4

      - name: Khởi tạo môi trường Node.js
        uses: actions/setup-node@v4
        with:
          node-version: 24

      - name: Cài đặt thư viện dependencies
        run: npm install

      - name: Thực thi Tập lệnh rsi.js
        env:
          BOT_TOKEN: ${{ secrets.BOT_TOKEN }}
          CHAT_ID: ${{ secrets.CHAT_ID }}
        run: node rsi.js

      - name: Commit & Push dữ liệu nhật ký sent_rsi.json mới
        run: |
          # Thiết lập cấu hình danh tính Git hệ thống
          git config --global user.name "github-actions[bot]"
          git config --global user.email "41898282+github-actions[bot]@users.noreply.github.com"
          
          # Theo dõi tệp log chống trùng tín hiệu
          git add sent_rsi.json
          
          # Chỉ push mã nguồn lên nếu tệp JSON có sự thay đổi thời gian cooldown thực sự
          if git diff --cached --quiet; then
            echo "Không phát hiện thay đổi trong file log. Bỏ qua bước đẩy mã nguồn lên."
          else
            git commit -m "🤖 [Bot Action] Cập nhật bộ đếm ngược chống trùng lệnh sent_rsi.json [skip ci]"
            git push origin HEAD:${{ github.ref }}
          fi
