FROM node:18-alpine

WORKDIR /app

# Copy package files
COPY package*.json ./
RUN npm ci --only=production

# Copy only necessary application files
COPY index.js ./
COPY models ./models
COPY middleware ./middleware

EXPOSE 3500

CMD ["node", "index.js"]
