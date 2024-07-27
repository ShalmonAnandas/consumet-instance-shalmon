import { FastifyRequest, FastifyReply, FastifyInstance, RegisterOptions } from 'fastify';
import { MOVIES } from '@consumet/extensions';
import { IMovieResult, ISearch, StreamingServers } from '@consumet/extensions/dist/models';
import axios from 'axios';

const routes = async (fastify: FastifyInstance, options: RegisterOptions) => {
  const dramacool = new MOVIES.DramaCool();

  async function getBase64ImageFromUrl(imageUrl: string): Promise<string | null> {
    try {
      const image = await axios.get(imageUrl, { responseType: 'arraybuffer' });
      const buffer = Buffer.from(image.data, 'binary');
      const base64Image = buffer.toString('base64');
      return `data:image/jpeg;base64,${base64Image}`;
    } catch (error) {
      console.error('Error fetching image:', error);
      return null;
    }
  }

  async function updateMoviesWithBase64ImagesForSearch(movies: ISearch<IMovieResult>): Promise<ISearch<IMovieResult>> {
    const updatedMovies = await Promise.all(movies.results.map(async (movie) => {
      const base64Image = await getBase64ImageFromUrl(movie.image!);
      return { ...movie, base64Image };
    }));
    movies["results"] = updatedMovies;
    return movies;
  }

  fastify.get('/', (_, rp) => {
    rp.status(200).send({
      intro:
        "Welcome to the flixhq provider: check out the provider's website @ https://flixhq.to/",
      routes: ['/:query', '/info', '/watch'],
      documentation: 'https://docs.consumet.org/#tag/flixhq',
    });
  });

  fastify.get('/:query', async (request: FastifyRequest, reply: FastifyReply) => {
    const query = decodeURIComponent((request.params as { query: string }).query);

    const page = (request.query as { page: number }).page;

    const res = await dramacool.search(query, page);

    let updatedMovies = await updateMoviesWithBase64ImagesForSearch(res);

    reply.status(200).send(updatedMovies);
  });

  fastify.get('/info', async (request: FastifyRequest, reply: FastifyReply) => {
    const id = (request.query as { id: string }).id;

    if (typeof id === 'undefined')
      return reply.status(400).send({
        message: 'id is required',
      });

    try {
      const res = await dramacool
        .fetchMediaInfo(id)
        .catch((err) => reply.status(404).send({ message: err }));

      let updatedImage = await getBase64ImageFromUrl(res.image!);
      res.image = updatedImage!;

      let updatedCover = await getBase64ImageFromUrl(res.cover!);
      res.cover = updatedCover!;

      reply.status(200).send(res);
    } catch (err) {
      reply.status(500).send({
        message:
          'Something went wrong. Please try again later. or contact the developers.',
      });
    }
  });

  fastify.get('/watch', async (request: FastifyRequest, reply: FastifyReply) => {
    const episodeId = (request.query as { episodeId: string }).episodeId;
    // const mediaId = (request.query as { mediaId: string }).mediaId;
    // const server = (request.query as { server: StreamingServers }).server;

    if (typeof episodeId === 'undefined')
      return reply.status(400).send({ message: 'episodeId is required' });
    try {
      const res = await dramacool
        .fetchEpisodeSources(episodeId)
        .catch((err) => reply.status(404).send({ message: 'Media Not found.' }));

      reply.status(200).send(res);
    } catch (err) {
      reply
        .status(500)
        .send({ message: 'Something went wrong. Please try again later.' });
    }
  });
};

export default routes;
